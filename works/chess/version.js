/*
    资源版本号（构建期生成，勿手改）

    用于给 salmonia.wasm / salmonia.wasm.gz 加 ?v= 查询串：
    静态托管通常无法自定义 Cache-Control，不换 URL 的话
    浏览器会把旧引擎一直缓存下去。

    重新生成：node build/wasm_probe/stamp_version.mjs
*/

export const ASSET_VERSION = '22ce84977e8b';
