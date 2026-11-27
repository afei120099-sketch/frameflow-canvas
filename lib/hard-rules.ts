/**
 * 硬拦截规则表（2026-11-12）：卡片按正本 h3q 拦镜头时，h3q 报的**每一条单镜 ERROR 都拦**（用户：卡片就是为了减少渲染出错，
 * 有错就改到没错再渲）。这张表只决定：按哪个前缀归成一组、显示什么名字、写什么规则和改法、h3q 没跑成时画布能不能自己兜底。
 * 以后正本加新的硬规则，往 HARD_RULES 里加一行就行；不加也照样拦（归进「正本 h3q 写错」那一组，显示 h3q 原话）。
 * 画面五项 [五项·…] 不在这张表里：它们是完整度类别，在卡片上显示成五个标签（lib/shot-gate.ts）。
 * 整集的 ERROR（不属于某一镜：一致性、对照表……）只显示、不拦——没有逐镜「我确认没问题」可点。
 * 本集设定里的值写错时，h3q 报在 general「本集设定.X」上，attachEpisodeH3qItems 会抄到用到它的镜头上，所以照样按镜头拦。
 * 2026-11-13：加正本官方 Ref2VA 六段式的 [官方·xx] 前缀（h3q 6f71917）。v2026-11-13.1（f053768）起 [旧格式] 是每镜一条 ERROR（照拦，可「我确认没问题」放行）；6f71917 那版的整份队列 [旧格式] WARN 仍在卡片 h3q 小卡片里醒目显示。
 * 2026-11-12：用户否决了「同一镜同性别最多一人有台词」，正本撤回到 v2026-11-12.2（h3工具 66993ac），[同性别对白] [说话人站位] 不进这张表。
 */
import { OPENING_GAP_FIXES, OPENING_GAP_ID, OPENING_GAP_LABEL, OPENING_GAP_RULE } from "./opening-gap.ts";
import { OFFICIAL_VOICE_ID, OFFICIAL_VOICE_LABEL } from "./official-format.ts";

export interface HardRule {
  /** h3q 消息里的前缀，按它归类（后面的文字正本可能改） */
  prefix: string;
  id: string;
  label: string;
  /** 一句话规则（卡片红字、复制给 AI） */
  rule: string;
  /** 改法；h3q 原话里已经带了 ①②③ 时不重复 */
  fixes: string;
  /** h3q 没跑成时画布有没有自己的判断（有的在 shotGate 里接） */
  canvasFallback: boolean;
}

export const HARD_RULES: readonly HardRule[] = [
  { prefix: "[开场空白]", id: OPENING_GAP_ID, label: OPENING_GAP_LABEL, rule: OPENING_GAP_RULE, fixes: OPENING_GAP_FIXES, canvasFallback: true },
  // 正本 v2026-11-13 官方 Ref2VA 六段式（h3q official_checks，前缀 [官方·xx]）。WARN 的几条（闭嘴 / 禁止句 / summary）只显示不拦，这里写上名字和改法备用。
  // h3q 没跑成时画布查不了这些写法（canvasFallback: false），兜底只有画面五项（英文词，和 h3q official_five 同一套）。
  { prefix: "[官方·六栏]", id: "official_sections", label: "官方·六栏", rule: "官方格式六栏齐全、按顺序、不空：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，不混旧写法的中文行", fixes: "补齐缺的栏、按顺序排，栏目名英文原样写在行首加冒号；不要配乐的 non_diegetic_music 写 N/A", canvasFallback: false },
  { prefix: "[官方·三栏]", id: "official_base_sections", label: "官方·三栏", rule: "没有参考图的镜头（T2VA / I2VA / FL2VA / L2VA）写三栏式：integrated_multimodal_description / overall_soundscape / non_diegetic_music，齐全、按顺序、不空", fixes: "补齐缺的栏、按顺序排；不要配乐的 non_diegetic_music 写 N/A", canvasFallback: false },
  { prefix: "[官方·对齐句]", id: "official_align", label: "官方·对齐句", rule: "三栏式第一行：T2VA 不写对齐句；I2VA / FL2VA / L2VA 照官方原句写对齐句，再空一行写 integrated_multimodal_description", fixes: "照 h3q get 提示词 官方格式 里的三种原句写，结尾帧写实际片长（两位小数）", canvasFallback: false },
  { prefix: "[官方·类型]", id: "official_type", label: "官方·类型", rule: "格式要和镜头类型对上：绑了场景图 / 角色图写 Ref2VA 六段式，没有参考图写三栏式", fixes: "按 h3q 原话换成对应的格式", canvasFallback: false },
  { prefix: "[官方·本集设定]", id: "official_episode", label: "官方·本集设定", rule: "官方格式不用 {{本集.…}} 占位，风格句、光线每镜写完整的英文", fixes: "把占位换成完整英文句子（整集逐字复制）", canvasFallback: false },
  { prefix: "[旧格式]", id: "legacy_format", label: "旧格式", rule: "正本 v2026-11-13.1 起旧格式（第一集中文写法）停用，每镜要按官方格式重写", fixes: "照正本官方格式重写（绑了参考图写 Ref2VA 六段式，没绑写三栏式），剧情、台词、人物、参考图、秒数不变，另存新版本；卡片「复制给 AI 修改」里有写法和范本", canvasFallback: false },
  { prefix: "[官方·Subject]", id: "official_subject", label: "官方·Subject", rule: "人物和场景先在 subject_definitions 里定义成 <Subject N>（从 1 连续编），写明来自哪张 <Picture N>，正文只用定义过的编号", fixes: "每个人物、场景一行「<Subject N> is … from <Picture M>」；正文用到的编号都要定义", canvasFallback: false },
  { prefix: "[官方·台词]", id: "official_lines", label: "官方·台词", rule: "台词只写在 detailed_description 的 <d>[Chinese] 原话</d> 里，前面写 <Subject N>、声音描述和说话人编号 (S1)；dialogue 字段留空", fixes: "写成「<Subject N>, a man … with a low voice (S1), says: <d>[Chinese] 原话。</d>」，summary 里不写原话", canvasFallback: false },
  { prefix: "[官方·切镜]", id: "official_cuts", label: "官方·切镜", rule: "detailed_description 用 [Shot 1]、[Shot 2] 连续编号，第二个镜头起写切点「At 00:04.000」，不写「0-3秒」这类时间段，切点不超过镜头时长", fixes: "动作按先后写，换镜头只写「[Shot N] At 00:0X.000, the shot cuts to …」", canvasFallback: false },
  { prefix: "[官方·声音]", id: "official_sound", label: "官方·声音", rule: "声音写对：overall_soundscape 只写环境声和动作声；non_diegetic_music 不要配乐写 N/A，要配乐写乐器、速度、强弱；送角色声音时，正文里的 <Audio N> 个数和顺序要和 voiceRoleIds 对上（Audio 1 = S1）", fixes: "按 h3q 原话改：台词从 overall_soundscape 挪回 detailed_description；non_diegetic_music 改成 N/A 或写清乐器；送声音的镜头让 voiceRoleIds 和 <Audio 1>、<Audio 2>… 一一对应，不送就两样都删", canvasFallback: false },
  { prefix: "[官方·中文]", id: "official_chinese", label: "官方·中文", rule: "官方格式除 <d> 里的台词和引号里的画面文字外全用英文", fixes: "把中文描述改成英文；人名在 subject_definitions 写拼音，正文用 <Subject N>", canvasFallback: false },
  { prefix: "[官方·追加句]", id: "official_appended", label: "官方·追加句", rule: "正文里不能有画布禁背景乐追加句（这段听到的 / Audible audio is …）；画布对官方格式原样提交，不会再加", fixes: "删掉这些句子，配乐写在 non_diegetic_music（N/A）", canvasFallback: false },
  // 官方格式送角色声音（voiceRoleIds 人数 = 正文 <Audio N> 个数，每人有主声音）。画布自己先查（lib/official-format.ts officialVoiceProblem，canvasFallback），
  // 正本 h3q 会加同样的检查，**前缀还没定**：定了把下面的 prefix 改成 h3q 的原样前缀，h3q 报了就用 h3q 那条（shotGate 不重复列）。
  { prefix: "[官方·角色声音]", id: OFFICIAL_VOICE_ID, label: OFFICIAL_VOICE_LABEL, rule: "官方格式写了 voiceRoleIds 才送角色声音：voiceRoleIds 的人数要和正文里 <Audio N> 的个数一样，编号从 <Audio 1> 连续，<Audio 1> 是第 1 个人的声音；每个人在角色库里都要有主声音", fixes: "正文按 voiceRoleIds 的顺序写 <Audio 1>、<Audio 2>…，或者把 voiceRoleIds 改成和正文一样；没有主声音的先在角色库设好", canvasFallback: true },
  { prefix: "[官方·禁止句]", id: "official_negative", label: "官方·禁止句", rule: "官方格式不写禁止句（no music / nobody speaks 会把那东西招来）", fixes: "删掉禁止句；不要配乐就在 non_diegetic_music 写 N/A，没人说话的地方只写动作", canvasFallback: false },
  { prefix: "[官方·闭嘴]", id: "official_close_mouth", label: "官方·闭嘴", rule: "每句台词后写一句闭嘴（He closes his mouth …）", fixes: "在 </d> 后面加「He/She closes his/her mouth and …」", canvasFallback: false },
  { prefix: "[官方·summary]", id: "official_summary", label: "官方·summary", rule: "summary 开头写任务类型方括号，参考图出片写 [reference generation]", fixes: "summary 第一句前加 [reference generation]", canvasFallback: false },
];

/** 不在表里的单镜 ERROR：照样拦，归成这一组。 */
export const OTHER_H3Q_ERROR = { id: "h3q_error", label: "正本 h3q 写错", rule: "正本 h3q 报的 ERROR（写法错误），改到 h3q 不报才能入队", fixes: "按 h3q 原话改正文" } as const;

export const hardRuleOf = (message: string) => HARD_RULES.find((rule) => message.includes(rule.prefix)) ?? null;
export const hardRuleById = (id: string) => HARD_RULES.find((rule) => rule.id === id) ?? (id === OTHER_H3Q_ERROR.id ? OTHER_H3Q_ERROR : null);
/** 原话后面接改法（原话已带 ①②③ 就不重复）。 */
export const withFixes = (note: string, fixes: string) => /①/.test(note) ? note : `${note}。${fixes}`;
