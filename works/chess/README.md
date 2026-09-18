# meraneko.top/chess

拟态（Neumorphism）国际象棋：留缝凸凹棋盘 + 白凸黑凹纯浮雕棋子 + 完整合法走子 + 人机对弈（Salomnia wasm）+ 棋钟。

## 文件

```
index.html           整页（单文件，除下面四个引擎文件外零依赖）
salmonia.wasm.gz     引擎本体（权重与开局库已内嵌），54MB 预压到 14.5MB
salmonia_loader.js   宿主：加载单文件 wasm + WASI shim + 逐行喂 UCI
salmonia_worker.js   把同步阻塞的搜索放进 Worker
version.js           产物内容哈希（构建期生成，勿手改）
```

站点页是 `chess/index.html`，不存在另一份副本——改页面就改这一个文件。引擎源码与 demo 在仓库的 `salmonia_wasm/`，与本目录是「源 → 发布产物」的关系。

## 本地预览

必须经 http（`file://` 下浏览器禁止 `fetch`，页面会**跳过引擎**，仍可当同机双人对下）：

```sh
python -m http.server 8765 --bind 127.0.0.1
# http://127.0.0.1:8765/chess/
```

首次加载要下 14.5MB 并实例化（初始内存 320MB、NNUE 约 90MB/worker、TT 64MB）；加载期间棋盘沿对角线填充表示下载进度，编译/启动段切换为呼吸态。手机上很可能加载失败，会自动降级为同机对下。

## 更新引擎

1. 在 `salmonia_wasm/` 里重建，并跑 `node build/wasm_probe/stamp_version.mjs` 生成新的 `version.js`。
2. 把新的 `salmonia.wasm.gz` 与 `version.js`（必须同一次构建）复制到本目录，替换同名文件。
3. 提交推送。页面请求的是 `salmonia.wasm.gz?v=<version.js 的哈希>`，换版本即换 URL，不会吃旧缓存。

## 部署

本目录随主站仓库 `lukrae/meraneko.top` 一起发布（Pages 从 `main` 分支根目录发布），无需额外配置——推上去后即为 https://meraneko.top/chess/。
