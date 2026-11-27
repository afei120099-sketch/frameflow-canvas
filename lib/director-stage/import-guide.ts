import { ANCHOR_FRAME_RANGE, MOTION_FRAME_RANGE, WHITEBOX_LIMITS } from "./schema.ts";
import { DIRECTOR_STAGE_FORMAT, IMPORT_DEFAULTS, type DirectorStageDocument } from "./import-format.ts";
import { aspectRatio, focalToVerticalFov } from "./whitebox.ts";

/**
 * 导演台「复制给 AI 的说明」正文。字段和规则以 lib/director-stage/import-format.ts 的校验为准；改校验时同步改这里。
 * 示例 DIRECTOR_STAGE_EXAMPLE 会被 scripts/test-director-stage-import.mjs 真的导入一遍，保证说明里的示例永远能用。
 */

/** 一间书房：书桌、椅子、书架、地毯，两个状态，两台摄影机，两个动作，一个空的参考包。 */
export const DIRECTOR_STAGE_EXAMPLE: DirectorStageDocument = {
  version: DIRECTOR_STAGE_FORMAT,
  scenes: [{
    name: "书房",
    room: { width: 4, depth: 5, height: 2.8 },
    props: [
      { name: "书桌", type: "desk", geometry: "box", position: [0, 0, -1.6], rotation: [0, 0, 0], size: [1.4, 0.75, 0.7] },
      { name: "椅子", type: "chair", geometry: "box", position: [0, 0, -0.9], rotation: [0, 0, 0], size: [0.45, 0.9, 0.45] },
      { name: "书架", type: "bookshelf", geometry: "box", position: [-1.8, 0, -1.2], rotation: [0, 90, 0], size: [1.2, 2, 0.35] },
      { name: "地毯", type: "rug", geometry: "plane", position: [0, 0.005, -0.9], rotation: [-90, 0, 0], size: [2, 1.6, 1] },
    ],
    states: [
      { name: "整洁", changes: [{ prop: "椅子", description: "推在书桌前，椅背朝门" }, { prop: "书架", description: "书排得整整齐齐" }] },
      { name: "被翻乱", changes: [{ prop: "椅子", description: "侧倒在地毯上" }, { prop: "书架", description: "第二层的书掉了一地" }] },
    ],
    cameras: [
      { name: "主机位", note: "门口平视全景，看到书桌和书架", position: [0, 1.5, 2.2], lookAt: [0, 0.9, -1.4], focalLength: 24, aspect: "9:16" },
      { name: "侧机位", note: "书桌右侧中景，人坐下时拍上半身", position: [1.5, 1.25, -0.6], lookAt: [0, 1, -1.2], focalLength: 50, aspect: "9:16" },
    ],
    motions: [
      { name: "椅子倒下", target: { prop: "椅子" }, keyframes: [
        { frame: 0, description: "立着", pose: { position: [0, 0, -0.9], rotation: [0, 0, 0] } },
        { frame: 18, description: "开始向右歪", pose: { position: [0.05, 0, -0.9], rotation: [0, 0, -35] } },
        { frame: 36, description: "侧倒在地毯上", pose: { position: [0.1, 0.225, -0.9], rotation: [0, 0, -90] } },
      ] },
      { name: "主机位慢推", target: { camera: "主机位" }, keyframes: [
        { frame: 0, description: "门口全景", pose: { position: [0, 1.5, 2.2], lookAt: [0, 0.9, -1.4] } },
        { frame: 120, description: "推到书桌前两米", pose: { position: [0, 1.4, 0.6], lookAt: [0, 0.9, -1.4] } },
      ] },
    ],
    controlPackages: [
      { name: "书房参考图", type: "reference", assetIds: [] },
    ],
  }],
};

const L = WHITEBOX_LIMITS;
const deg = (value: number) => `${value.toFixed(1)}°`;
const horizontalFov = (focal: number, aspect: "9:16" | "16:9") => (2 * Math.atan(Math.tan((focalToVerticalFov(focal) * Math.PI) / 360) * aspectRatio(aspect)) * 180) / Math.PI;
const coverage = (fovDeg: number) => (2 * Math.tan((fovDeg * Math.PI) / 360)).toFixed(2);
const LENS_ROWS = [16, 24, 35, 50, 85, 135].map((focal) => {
  const vertical = focalToVerticalFov(focal);
  return `| ${focal} mm | ${deg(vertical)} | ${deg(horizontalFov(focal, "9:16"))} | ${coverage(horizontalFov(focal, "9:16"))} × 距离 | ${deg(horizontalFov(focal, "16:9"))} | ${coverage(horizontalFov(focal, "16:9"))} × 距离 | ${coverage(vertical)} × 距离 |`;
}).join("\n");

export const DIRECTOR_STAGE_GUIDE = `# 画布「导演台」建模说明（写 ${DIRECTOR_STAGE_FORMAT} JSON 的 AI 请照这个写）

用户会把你写的 JSON 粘进画布导演台的「从 JSON 导入」。导演台是一个白模场景工具：一个场景 = 一个房间盒子 + 若干方盒 / 平面道具 + 状态 + 摄影机 + 动作 + 控制素材包。导入后用户在白模导演台（3D）里看，再用摄影机出白模首帧 / 控制图，交给海螺 H3 出片。
导入前会逐项检查，出错会用中文指出哪个场景、哪一项、哪个字段、怎么改。只输出 JSON，不要加注释。

## 1. 坐标系和单位（最重要）
- 单位：长度一律是**米**，角度一律是**度**，帧号按 **24 帧 = 1 秒**。
- 原点：房间**地面的正中心**。Y 轴朝上（地面 y = 0，天花板 y = 房间高）。
- X 轴：房间的宽，向右为 +x，左右墙在 x = ±宽/2。
- Z 轴：房间的深。+z 那面墙叫「前墙」（门口，新摄影机默认放在这一侧往里看），−z 那面墙叫「后墙」，在 z = ±深/2。
- 所以「从门口往里看」就是看向 −z；画面里的右边是 +x、左边是 −x。
- 旋转 rotation = [绕 X, 绕 Y, 绕 Z]（度，three.js 默认的 XYZ 顺序），范围 ${-L.rotation} 到 ${L.rotation}。
  - 绕 Y（第二个数）是「转身」：从上往下看，正数是**逆时针**。原来朝 −z 的东西转 +90 后朝 −x（左墙），转 −90 后朝 +x（右墙），转 180 朝门口。
  - 绕 Z（第三个数）是「向侧面倒」：正数往 −x（左）倒，负数往 +x（右）倒。绕 X（第一个数）是「前后仰」：正数顶部往 +z 倒（往门口方向），负数顶部往 −z 倒（往后墙方向）。
- 位置范围 ${-L.position} 到 ${L.position} 米；道具尺寸 ${L.scaleMin} 到 ${L.scaleMax} 米；房间宽深高 ${L.roomMin} 到 ${L.roomMax} 米。

## 2. 道具是怎么摆的
- 道具只有两种形状：geometry = "box"（方盒）或 "plane"（平面）。椅子、桌子、柜子、人的占位都用方盒。
- **方盒的 position 是它底面的中心**（不是体心）：放在地上就写 y = 0；放在 0.75 米高的桌面上就写 y = 0.75。size = [宽(x), 高(y), 深(z)]，是旋转前的尺寸。
- **平面的 position 是它的中心**。平面本来是竖着的、正面朝 +z（朝门口），size = [宽, 高, 1]（第三个数没用，写 1）。
  - 铺在地上（地毯、水渍、影子）：rotation = [-90, 0, 0]，y 写 0.005（略高于地面防闪），size = [x 方向长, z 方向长, 1]。
  - 贴在墙上（画、门、窗）：后墙上 rotation = [0, 0, 0]，z 写 −深/2 + 0.01；左墙 rotation = [0, 90, 0]；右墙 rotation = [0, -90, 0]。
- 道具贴墙：方盒中心离墙 = 它那一边厚度的一半。例：深 5 米的房间，0.35 米厚的书架靠后墙 → z = −2.5 + 0.175 = −2.325。
- 道具不写 position 也可以：那就是只有名字的「文字道具」，不会出现在白模里（可以先让状态引用它）。写了 rotation / size 就必须写 position。
- 没写 rotation：方盒默认 [0, 0, 0]，平面默认 [-90, 0, 0]（铺在地上）。没写 size：方盒默认 ${JSON.stringify(IMPORT_DEFAULTS.boxSize)}（椅子大小），平面默认 [1, 1, 1]。

## 3. 摄影机
- position = 镜头所在的点（米）。人眼高度站姿约 1.5–1.6，坐姿约 1.1–1.2，低机位 0.3–0.6。
- 朝向**推荐写 lookAt**：摄影机看向的那个点 [x, y, z]，导入时自动换算成 rotation，不会歪（不会滚转）。lookAt 和 rotation 只写一个。
  - 要看人的脸：lookAt 的 y 写脸的高度（站 1.55、坐 1.15）。要看桌面：y 写桌面高度。
  - 直接写 rotation 也行：摄影机看向自己的 −z；[0, 0, 0] 就是平着看向后墙。但同时有俯仰和转向时 XYZ 顺序容易算错，所以优先用 lookAt。
- focalLength：焦距，全画幅等效毫米，${L.focalMin}–${L.focalMax}，不写默认 ${IMPORT_DEFAULTS.focalLength}。aspect：只能 "9:16"（竖屏，默认）或 "16:9"（横屏）。
- 导演台没有「景别」字段，景别由**焦距 + 距离**决定。下表是画面能拍到多宽 / 多高（宽 = 系数 × 摄影机到被摄物的距离）：

| 焦距 | 竖直视角 | 9:16 水平视角 | 9:16 画面宽 | 16:9 水平视角 | 16:9 画面宽 | 画面高（9:16 和 16:9 都一样） |
|---|---|---|---|---|---|---|
${LENS_ROWS}

  - 注意：**竖屏 9:16 很窄**。35 mm 竖屏在 3 米外只拍到约 1.2 米宽。竖屏全景常用 16–24 mm。
  - 景别参考（按要拍进的高度算距离 = 想拍的高度 ÷ 画面高系数）：全身约 2 米高、中景（腰以上）约 1 米、近景（胸以上）约 0.6 米、特写（脸）约 0.3 米。
  - 摄影机必须在房间里面（|x| < 宽/2、|z| < 深/2、0 < y < 高），否则拍到的是墙外面。
- note：备注，写景别、意图，比如「门口平视全景」。不影响出图。

## 4. 状态（同一个场景的不同时刻）
- 一个状态 = 一组「哪个道具变成什么样」的文字描述：{"name": "被翻乱", "changes": [{"prop": "椅子", "description": "侧倒在地毯上"}]}。
- prop 写道具的 name（必须是这个场景 props 里有的），同一状态里同一道具只写一次。状态只是文字，**不会移动白模**；要白模里真的动，用第 5 节的动作。

## 5. 动作 Motion（导演规划，H3 不会精确按帧执行）
- {"name": "椅子倒下", "target": {"prop": "椅子"}, "keyframes": [...]}；target 写 {"prop": "道具名"} 或 {"camera": "摄影机名"}，只写一个。
- 关键帧：{"frame": 帧号, "description": "这一帧的样子", "pose": {...}}。frame 是 ${MOTION_FRAME_RANGE.min}–${MOTION_FRAME_RANGE.max} 的整数（24 帧 = 1 秒），同一动作里不能重复，导入时自动按帧号排序。
- pose 可选：写了就能在白模导演台里播放预览。pose = {"position": [...], "rotation" 或 "lookAt": [...], "size": [...]}。size 只给道具写，不写就沿用道具自己的 size；摄影机用 lookAt 最方便。
- 目标没写 position（没放进白模）时，关键帧不能带 pose。
- 一个 H3 镜头最长约 15 秒（360 帧），动作关键帧尽量落在这个范围里。

## 6. 控制素材包（大多数情况写空数组）
- controlPackages 只引用画布素材库里**已经有的**素材（按 Asset ID）。AI 不能生成图片、也不能编素材 ID；不知道 ID 就写 "assetIds": []，导入后用户在导演台里绑定，或用「白模首帧 / 写实首帧」按钮自动生成。
- type：first_frame（首帧，1 张图）、last_frame（尾帧，1 张图）、reference（参考，最多 9 个图 / 视频 / 声音）、guide（🧪 引导锚点，最多 9 张，必须写 anchorFrame = ${ANCHOR_FRAME_RANGE.min}–${ANCHOR_FRAME_RANGE.max} 的帧号）、depth / mask / object_id（Blender 控制图，各 1 张，目前不送 H3）。
- 只有 guide 写 anchorFrame。

## 7. 字段总表
最外层：{"version": "${DIRECTOR_STAGE_FORMAT}", "scenes": [场景, ...]}，两个都必填，scenes 至少一个。

| 位置 | 字段 | 类型 / 单位 | 必填 | 说明 |
|---|---|---|---|---|
| 场景 | name | 文字，≤80 字 | 是 | 同一文件里不能重名；和画布里已有场景同名时，导入会问「覆盖」还是「另存」 |
| 场景 | room | {width, depth, height} 米 | 否 | 房间盒子，不写就没有房间（白模里只有道具）。常见：卧室 3.5×4×2.8，客厅 5×6×2.9 |
| 场景 | props / states / cameras / motions / controlPackages | 数组 | 否 | 不写当作 [] |
| 道具 | name | 文字 ≤80 | 是 | 场景内不重名，状态和动作靠它引用 |
| 道具 | type | 文字 ≤40 | 是 | 自由写，如 chair、desk、door、person |
| 道具 | geometry | "box" / "plane" | 否 | 写了 position 而没写 geometry 时当 box |
| 道具 | position / rotation / size | [x,y,z] 米 / 度 / 米 | 否 | 见第 1、2 节 |
| 状态 | name | 文字 ≤80 | 是 | |
| 状态 | changes | [{prop, description}] | 否 | prop = 道具 name；description ≤500 字 |
| 摄影机 | name | 文字 ≤80 | 是 | |
| 摄影机 | position | [x,y,z] 米 | 否 | 不写就是没放进白模的摄影机，出不了首帧 |
| 摄影机 | lookAt 或 rotation | [x,y,z] 米 / 度 | 否 | 只写一个 |
| 摄影机 | focalLength | 数字 mm，${L.focalMin}–${L.focalMax} | 否 | 默认 ${IMPORT_DEFAULTS.focalLength} |
| 摄影机 | aspect | "9:16" / "16:9" | 否 | 默认 "9:16" |
| 摄影机 | note | 文字 ≤500 | 否 | |
| 动作 | name / target / keyframes | 见第 5 节 | name、target 是 | |
| 控制素材包 | name / type / assetIds / anchorFrame | 见第 6 节 | name、type 是 | |
| 任意一项 | id | 文字 | 否 | 新建时不写。用「导出 JSON」得到的文件里每项都有 id，**原样保留**，覆盖导入时就会更新同一条记录（镜头绑定不会断） |

## 8. 完整示例（一间书房）
\`\`\`json
${JSON.stringify(DIRECTOR_STAGE_EXAMPLE, null, 2)}
\`\`\`
这个示例里：房间宽 4、深 5、高 2.8；书桌靠后墙方向（z = −1.6），椅子在书桌前；书架转了 90° 立在左墙边；地毯是铺在地上的平面。主机位在门口 1.5 米高，用 24 mm 竖屏拍全景；侧机位在书桌右前方，50 mm 拍中景。

## 9. 在已有场景上改
- 用户可以先点导演台的「导出 JSON」，把文件发给你。你在上面改，**保留每项的 id 和场景名**，只改要改的字段，再交回来；用户导入时选「覆盖」。
- 覆盖 = 这个场景改成 JSON 里的样子：JSON 里没有的道具 / 状态 / 摄影机 / 动作 / 素材包会被删掉。所以别只交改动的那一项，要交整个场景。
- 自动生成的素材包（白模首帧、控制组、写实首帧）不会出现在导出文件里，覆盖时原样保留。
- 导入后用户可以点「撤销这次导入」恢复原样。

## 10. 常见错误
1. 单位写成厘米（"position": [0, 0, -160]）。导演台全是米：-1.6。
2. 方盒放在地上 y 却写了高度的一半。方盒原点在**底面**，地上就是 y = 0。
3. 竖屏 9:16 用 35 mm 以上拍全景，结果只拍到一小块。先查第 3 节的表。
4. 摄影机放在墙外（比如深 5 米的房间 z 写 3）。前墙在 z = 2.5，摄影机至少往里 0.2 米。
5. 同时写 rotation 和 lookAt，或写了 lookAt 却没写 position。
6. 状态 / 动作里引用的道具名和 props 里的 name 不一致（多了空格、简繁体不同、写成 type）。
7. 把字段写成别的名字：scale（应为 size）、pos（应为 position）、fov（应为 focalLength，单位是毫米不是角度）、propChanges（应为 changes）。
8. 编造 assetIds。不知道就写 []。
9. guide 包忘了 anchorFrame，或别的包写了 anchorFrame。
10. 同一动作两个关键帧帧号一样；帧号写成秒（应为秒 × 24）。
11. JSON 里加了注释、用了中文引号“”、末尾多了逗号。

## 11. 导入后用户还要自己做的（JSON 填不了）
- 生成白模首帧 / 控制图 / 写实首帧（要用户在导演台里点按钮，会跑 Blender 或 ComfyUI）。
- 新建「镜头 Shot」并绑定机位、状态、首帧包，再「发送到 H3」。这些不在导入格式里。
- 给控制素材包绑定素材库里的图片。
`;
