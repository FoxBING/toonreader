# ToonReader

用 Tauri 写的条漫（webtoon）阅读器：拖入文件夹即按文件名顺序纵向连续阅读，
后台自动用 **waifu2x-ncnn-vulkan（cunet 模型）×2** 放大，领先阅读位置预加载 10 张。

## 功能

- **拖入即读**：文件夹内图片按文件名 *自然排序*（`2.jpg` < `10.jpg`），纵向连续滚动
- **模式选择**：顶栏 `AI ×2` 按钮一键切换，**默认不开放大（原图模式）**；开启后原图立即显示，后台逐张跑 waifu2x，完成后当前页淡入替换为 ×2 版本（右上角 `×2` 徽标）
- **预加载 10 张**：阅读位置前方 10 张提前放大 + 提前解码，滚过去基本就是高清版
- **持久缓存**：放大结果保存在 `%APPDATA%\com.toonreader.app\cache\<文件夹哈希>\`，下次打开同一文件夹直接秒加载（按文件名/大小/修改时间校验）
- **阅读进度记忆**：每个文件夹自动记住读到的位置，下次打开（拖入、带参启动或从最近列表点击）直接定位到历史进度；欢迎页有"最近阅读"列表可一键续读
- **虚拟化渲染**：只挂载视口附近的 `<img>`，几百上千张也不吃内存；底部滑块快速跳页
- 快捷键：`PageUp/PageDown` 翻页、`Home/End` 首尾、`S` 设置、`F` 全屏

## 运行

需要 Rust（MSVC 工具链）：

```bash
cargo install tauri-cli --locked
cargo tauri dev      # 开发运行
cargo tauri build    # 打包 exe（nsis）
```

## waifu2x 配置

本仓库把 waifu2x 相关文件统一放在 `waifu2x\` 子文件夹
（`waifu2x-ncnn-vulkan.exe`、`vcomp140.dll`、`models-cunet` 等，见 [waifu2x/waifu2x-README.md](waifu2x/waifu2x-README.md)），
程序会在工作目录 / exe 上级目录自动探测 `waifu2x\waifu2x-ncnn-vulkan.exe` 与根目录两种布局，**通常零配置**。
也可以在设置（⚙ 或 `S`）里显式指定：

- **waifu2x 程序路径**：`waifu2x-ncnn-vulkan.exe` 的完整路径
- **模型目录**：默认 `<waifu2x 程序目录>\models-cunet`（cunet 对动漫线条画质最好）
- **降噪级别** `-n`：jpg 压缩噪点多建议 1~2，默认 0
- **预加载张数**：默认 10（即"领先放大 10 张"）
- **GPU / Tile**：多显卡或显存不足时调整

## 说明

- 只扫描文件夹**第一层**的图片（jpg / jpeg / jfif / png / webp / bmp），按文件名排序
- waifu2x 未开启 / 不可用时就是纯原图阅读，不影响使用
- 也支持 `toonreader.exe <文件夹>` 直接带参启动（把文件夹拖到 exe 图标上同样有效）
- 放大结果按 `00001.png`… 编号与排序后的源文件一一对应；删缓存目录即可重置
