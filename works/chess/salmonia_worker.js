/*
    Salmonia 引擎 Worker

    搜索在 wasm 里是同步阻塞且不可中断的，放在 Worker
    执行，页面才不会在思考期间卡住（棋盘、动画、按钮都正常）。

    页面按深度分块驱动分析，块与块之间 Worker 能处理新消息，
    停分析 = 不再派发后续分块（在飞的这一块受 movetime 上限约束）。

    协议（页面 -> Worker）：
        { id, type:'load',  payload:{ url, gzUrl } }
        { id, type:'cmd',   payload:{ line } }
        { id, type:'reset' }
    回包：
        { id, ok:true,  result }
        { id, ok:false, error:{ code, message } }
        { type:'progress', loaded, total }        // 加载进度
*/

import Salmonia from './salmonia_loader.js';

let engine = null;

self.onmessage = async (event) => {

    const { id, type, payload } = event.data;

    try {

        let result = null;

        if (type === 'load') {

            engine = await Salmonia.load(payload.url, {
                gzUrl: payload.gzUrl,
                onProgress: ({ loaded, total }) =>
                    self.postMessage({ type: 'progress', loaded, total }),
                onPhase: (phase) =>
                    self.postMessage({ type: 'phase', phase }),
            });

            result = {
                log: engine.init(),
                heapMB: engine.heapMB(),
                missing: engine.missingImports,
            };

        }

        else if (type === 'cmd') {

            result = engine.send(payload.line);

        }

        else if (type === 'reset') {

            engine.reset();

        }

        else {

            throw new Error(`unknown message: ${type}`);

        }

        self.postMessage({ id, ok: true, result });

    } catch (err) {

        self.postMessage({
            id,
            ok: false,
            error: {
                code: err.code || 'unknown',
                message: err.message || String(err),
            },
        });

    }

};
