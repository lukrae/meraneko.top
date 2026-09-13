/*
    Salmonia 浏览器宿主

    加载单文件 salmonia.wasm（内嵌 NNUE 与 Polyglot 开局库），
    逐行投递 UCI 命令。本文件不含任何引擎逻辑。

    传输策略：
        取预压缩的 salmonia.wasm.gz，把下载流直接喂给
        DecompressionStream 再交给 instantiateStreaming，边下边解压
        边编译，JS 侧不产生 54 MB 中间副本；不支持流式解压或
        .gz 不存在时回退原始 .wasm。

    加载前先做能力探测（SIMD / wasm 异常），避免先下 12 MB
    再抛一个难懂的 CompileError。
*/

const WASI_ERRNO = {
    EBADF: 8,
    EINVAL: 28,
    ENOENT: 2,
    ENOSYS: 52,
};

// 错误分类：宿主按 code 给出可读提示
export const ERR = {
    SIMD: 'simd',
    EH: 'eh',
    NETWORK: 'network',
    INSTANTIATE: 'instantiate',
    INIT: 'init',
};

function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/*
    最小探测模块

    SIMD：一个返回 v128 的函数（-msimd128 产物需要）
    异常：一个 tag 段（-fwasm-exceptions 产物需要）
*/

const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
]);

const EH_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x0d, 0x03, 0x01, 0x00, 0x00,
]);

function capabilityGap() {
    try {
        if (!WebAssembly.validate(SIMD_PROBE))
            return ERR.SIMD;
        if (!WebAssembly.validate(EH_PROBE))
            return ERR.EH;
    } catch {
        return ERR.SIMD;
    }
    return null;
}

export class Salmonia {
    constructor() {
        this.instance = null;
        this.memory = null;
        this.stdout = '';
        this.stderr = '';
        this.missingImports = [];
        this._decoders = new Map();
        this._encoder = new TextEncoder();
    }

    // --------------------------------------------------------
    // 加载并实例化
    // --------------------------------------------------------

    static async load(url = './salmonia.wasm', { onProgress, onPhase, gzUrl, noGzip } = {}) {
        const gap = capabilityGap();

        if (gap === ERR.SIMD)
            throw fail(gap, '此浏览器不支持 wasm SIMD（需要 iOS 16.4+ / 较新的桌面浏览器）');

        if (gap === ERR.EH)
            throw fail(gap, '此浏览器不支持 wasm 异常处理（浏览器版本过旧）');

        const eng = new Salmonia();
        await eng._instantiate(url, noGzip ? null : gzUrl, onProgress, onPhase);
        return eng;
    }

    /*
        取模块字节流

        返回一个 content-type 为 application/wasm 的 Response，
        便于走 instantiateStreaming
    */
    async _fetchModule(url, gzUrl, onProgress) {

        const asWasm = (body, total) => new Response(
            onProgress ? this._count(body, total, onProgress) : body,
            { headers: { 'content-type': 'application/wasm' } }
        );

        /*
            不做分片并发：浏览器里多路 Range 流共享同一条 h2 连接，带宽仍是
            链子上限（同一时刻、同一 CDN：单流 44s / 8 路 54s），还丢了边下
            边编译的重叠。curl 靠多开 TCP 能提速，页面不能。
        */
        if (typeof DecompressionStream === 'function') {

            let gz = null;

            try {
                gz = await fetch(gzUrl || `${url}.gz`, { cache: 'force-cache' });
            } catch {
                gz = null;
            }

            if (gz && gz.ok && gz.body) {

                /*
                    在压缩流上计数：loaded / total 才是真实下载比例。
                    计在解压流上会跑到 3.7 倍，页面进度早就满了。
                */
                const total = Number(gz.headers.get('content-length')) || 0;

                /*
                    宿主已按 Content-Encoding 代理解压：拿到的就是 wasm 本体，
                    长度与压缩体不符，报 total 0 让页面维持当前进度
                */
                if ((gz.headers.get('content-encoding') || '').includes('gzip'))
                    return { response: asWasm(gz.body, 0), compressed: false };

                try {
                    return {
                        response: new Response(
                            (onProgress ? this._count(gz.body, total, onProgress) : gz.body)
                                .pipeThrough(new DecompressionStream('gzip')),
                            { headers: { 'content-type': 'application/wasm' } }
                        ),
                        compressed: true,
                    };
                } catch {
                    // 解压不可用：走原始文件
                }
            }
        }

        return { response: await this._fetchRaw(url, onProgress), compressed: false };
    }

    async _fetchRaw(url, onProgress) {

        let raw = null;

        try {
            raw = await fetch(url, { cache: 'force-cache' });
        } catch (err) {
            throw fail(ERR.NETWORK, `取 wasm 失败：${err.message}`);
        }

        if (!raw.ok)
            throw fail(ERR.NETWORK, `取 wasm 失败：HTTP ${raw.status}`);

        const total = Number(raw.headers.get('content-length')) || 0;

        return new Response(
            onProgress ? this._count(raw.body, total, onProgress) : raw.body,
            { headers: { 'content-type': 'application/wasm' } }
        );
    }

    // 统计已下载字节数（在压缩流上计数，即真实传输量）
    _count(body, total, onProgress) {
        let loaded = 0;
        return body.pipeThrough(new TransformStream({
            transform: (chunk, controller) => {
                loaded += chunk.byteLength;
                onProgress({ loaded, total });
                controller.enqueue(chunk);
            },
        }));
    }

    // 编译：能流式就流式，否则落成 ArrayBuffer
    async _compile(response, imports) {

        const mime = response.headers.get('content-type') || '';

        if (WebAssembly.instantiateStreaming && mime.includes('application/wasm'))
            return WebAssembly.instantiateStreaming(response, imports);

        return WebAssembly.instantiate(await response.arrayBuffer(), imports);
    }

    async _instantiate(url, gzUrl, onProgress, onPhase) {

        const phase = onPhase || (() => {});
        const shim = this._wasiShim();

        phase('download');

        const fetched = await this._fetchModule(url, gzUrl, onProgress);

        let result = null;


        // 流式解压与编译是同一段（边解边编译），合并为一个阶段
        phase('compile');

        try {

            result = await this._compile(fetched.response, shim.imports);

        } catch (err) {

            /*
                压缩链路出问题（宿主在 .gz 地址上返回了非 gzip
                内容、解压中途失败等）时回退原始文件再试一次；
                原始文件也失败才算真的加载不了
            */

            if (!fetched.compressed)
                throw fail(ERR.INSTANTIATE, `wasm 实例化失败：${err.message}`);

            const raw = await this._fetchRaw(url, onProgress);

            try {
                result = await this._compile(raw, shim.imports);
            } catch (err2) {
                throw fail(ERR.INSTANTIATE, `wasm 实例化失败：${err2.message}`);
            }

        }


        this.instance = result.instance;
        this.memory = this.instance.exports.memory;

        if (!this.memory)
            throw fail(ERR.INSTANTIATE, '模块未导出 memory：无法读写线性内存');


        phase('start');

        // 静态构造（含转表分配）必须先跑完
        const ctors = this.instance.exports.__wasm_call_ctors
                   || this.instance.exports._initialize;

        if (ctors) {

            try {
                ctors();
            } catch (err) {
                throw fail(ERR.INIT, `初始化失败：${err.message}`);
            }

        }

        this.missingImports = shim.missing;
    }

    // --------------------------------------------------------
    // 引擎生命周期
    // --------------------------------------------------------

    init() {

        try {
            return this._takeString(this.instance.exports.salmonia_init());
        } catch (err) {
            throw fail(ERR.INIT, `引擎启动失败：${err.message}`);
        }

    }

    // 发送一行 UCI 命令，返回该命令期间引擎打印的全部内容
    send(line) {
        const bytes = this._encoder.encode(line ?? '');

        // 导出函数只收指针，先把这一行写进模块内存的暂存缓冲
        const capacity = this.instance.exports.salmonia_line_capacity();

        if (bytes.length >= capacity)
            throw new Error(`command too long: ${bytes.length} >= ${capacity}`);

        const ptr = this.instance.exports.salmonia_line_buffer();
        const buffer = this._bytes(ptr, bytes.length + 1);
        buffer.set(bytes);
        buffer[bytes.length] = 0;

        return this._takeString(this.instance.exports.salmonia_uci(ptr));
    }

    reset() {
        this.instance.exports.salmonia_reset();
    }

    // 堆当前大小（MB）：用于内存相关诊断
    heapMB() {
        return this.memory.buffer.byteLength / 1048576;
    }

    // --------------------------------------------------------
    // 内部：线性内存读写
    // --------------------------------------------------------

    _view() {
        return new DataView(this.memory.buffer);
    }

    _bytes(ptr, len) {
        return new Uint8Array(this.memory.buffer, ptr, len);
    }

    // 读取导出函数返回的持久 char*（每次调用会被覆盖，须立即取走）
    _takeString(ptr) {
        if (!ptr) return '';
        const view = new Uint8Array(this.memory.buffer);
        let end = ptr;
        while (view[end] !== 0) ++end;
        return new TextDecoder('utf8').decode(view.subarray(ptr, end));
    }

    // --------------------------------------------------------
    // WASI 预览1 导入
    // --------------------------------------------------------

    _wasiShim() {
        const self = this;
        const missing = [];

        const fdstat = (buf) => {
            const v = self._view();
            v.setUint8(buf, 1);                  // kind: character device
            v.setUint32(buf + 4, 0, true);       // flags
            v.setBigUint64(buf + 8, 0n, true);   // rights
            v.setBigUint64(buf + 16, 0n, true);
            v.setUint32(buf + 24, 1, true);      // filetype: tty
            return 0;
        };

        const wasi = {
            proc_exit: (code) => { throw new Error(`proc_exit(${code})`); },
            proc_raise: () => WASI_ERRNO.EINVAL,
            sched_yield: () => 0,

            clock_time_get: (id, _precision, out) => {
                const ns = id === 0
                    ? BigInt(Date.now()) * 1000000n
                    : BigInt(Math.round(globalThis.performance.now() * 1e6));
                self._view().setBigUint64(out, ns, true);
                return 0;
            },

            random_get: (buf, len) => {
                const u = self._bytes(buf, len);
                for (let i = 0; i < u.length; ++i) u[i] = Math.random() * 256 | 0;
                return 0;
            },

            environ_sizes_get: (countOut, bufSizeOut) => {
                const v = self._view();
                v.setUint32(countOut, 0, true);
                v.setUint32(bufSizeOut, 0, true);
                return 0;
            },
            environ_get: () => 0,
            args_sizes_get: (countOut, bufSizeOut) => {
                const v = self._view();
                v.setUint32(countOut, 0, true);
                v.setUint32(bufSizeOut, 0, true);
                return 0;
            },
            args_get: () => 0,

            fd_write: (fd, iovs, iovsLen, nwrittenOut) => {
                const v = self._view();
                let total = 0;
                const chunks = [];
                for (let i = 0; i < iovsLen; ++i) {
                    const base = iovs + i * 8;
                    const ptr = v.getUint32(base, true);
                    const len = v.getUint32(base + 4, true);
                    chunks.push(self._bytes(ptr, len));
                    total += len;
                }
                const merged = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) { merged.set(c, off); off += c.length; }

                let dec = self._decoders.get(fd);
                if (!dec) { dec = new TextDecoder('utf8'); self._decoders.set(fd, dec); }
                const text = dec.decode(merged, { stream: true });

                if (fd === 1) self.stdout += text;
                else if (fd === 2) self.stderr += text;

                v.setUint32(nwrittenOut, total, true);
                return 0;
            },

            // 无文件系统：读一律 EOF，其余全部 ENOSYS / ENOENT
            fd_read: (fd, iovs, iovsLen, nreadOut) => {
                self._view().setUint32(nreadOut, 0, true);
                return 0;
            },
            fd_seek: () => WASI_ERRNO.EBADF,
            fd_close: () => 0,
            fd_sync: () => 0,
            fd_fdstat_get: (fd, buf) => (fd < 3 ? fdstat(buf) : WASI_ERRNO.EBADF),
            fd_fdstat_set_flags: () => WASI_ERRNO.ENOSYS,
            fd_prestat_get: () => WASI_ERRNO.EBADF,
            fd_prestat_dir_name: () => WASI_ERRNO.EBADF,
            fd_filestat_get: () => WASI_ERRNO.EBADF,
            fd_filestat_set_size: () => WASI_ERRNO.ENOSYS,
            fd_filestat_set_times: () => WASI_ERRNO.ENOSYS,
            fd_readdir: () => WASI_ERRNO.ENOSYS,
            fd_renumber: () => 0,

            path_open: () => WASI_ERRNO.ENOENT,
            path_create_directory: () => WASI_ERRNO.ENOSYS,
            path_filestat_get: () => WASI_ERRNO.ENOENT,
            path_unlink_file: () => WASI_ERRNO.ENOSYS,
            path_rename: () => WASI_ERRNO.ENOSYS,

            poll_oneoff: () => WASI_ERRNO.ENOSYS,
            sock_shutdown: () => WASI_ERRNO.EBADF,
        };

        const forwardName = (mod, label) => new Proxy({}, {
            get: (_t, name) => {
                if (!(name in mod)) {
                    missing.push(`${label}.${String(name)}`);
                    // 未知导入：记名后给一个安全桩，便于一次性枚举全部缺口
                    return () => 0;
                }
                return mod[name];
            },
        });

        /*
            env 导入：内存增长回调
            视图每次访问都新建，没有需要失效的缓存，
            空实现即为正确语义
        */

        const env = {
            emscripten_notify_memory_growth: () => {},
        };

        const imports = {
            wasi_snapshot_preview1: forwardName(wasi, 'wasi'),
            env: forwardName(env, 'env'),
        };

        return { imports, missing };
    }
}

export default Salmonia;
