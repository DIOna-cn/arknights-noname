import { game, lib } from "noname";
import { content } from "./main/content.js";
import { precontent } from "./main/precontent.js";
import { DEFAULT_REPO, checkAndUpdate, getRepoSpec, parseRepoSpec } from "./main/update.js";

// 扩展入口文件：目录名必须与下面的 name 一致（扩展列表、config 键都靠它）。
// 读取 info.json，用于在「扩展」菜单里显示作者、版本、介绍。
//
// ★ 这里**不要**写死 `extension/方舟/info.json`。
//   引擎是按**目录名**加载扩展的（init/import.js 里是
//       importFunction("extension", `/extension/${name}/extension`)
//   ），所以目录叫什么它都能找到入口 —— 但写死的路径只认「方舟」这一个名字。
//   目录名一旦不完全一致（解压时被改名、或者外面多套了一层文件夹），
//   这一行就会 reject；而顶层 await 一抛错，**整个扩展加载失败**。
//   改成从 import.meta.url 反推自己的目录，怎么放都对；
//   再补一层兜底，连 info.json 缺失也不至于把扩展带崩
//   （引擎自己读它时也是这么兜的，见 init/import.js 的 createEmptyExtension）。
const extensionInfo = await lib.init.promises.json(new URL("info.json", import.meta.url).href).then(
	info => info,
	() => ({ name: "方舟", intro: "", author: "未知", version: "1.0.0" })
);

// ── 扩展设置 ────────────────────────────────────────────────────────
// 无名杀的扩展 config 是**扁平列表**（没有嵌套子页），所以「分支」用 clear: true 的
// 标题行来做 —— 这正是无名杀扩展的惯用写法（见内置的「启动界面美化」）。
// 每一项的存储键都是 extension_方舟_<这里的键名>，读的时候用 game.getExtensionConfig
// 或直接 lib.config["extension_方舟_<键>"]（skill.js 里的 arknightsCfg 就是后者）。
//
// onclick 一旦自己写了，UI 就**不会**再挂默认的保存逻辑（见 ui/create/menu/index.js），
// 所以下面每一项都必须自己调 game.saveExtensionConfig 存盘。
const EXT = "方舟";
/** 通用下拉项：存盘 + 让场上已经挂着的浮泡按新参数重建 */
const fxSetting = (key, name, init, item, intro) => ({
	name,
	init,
	item,
	intro,
	onclick(result) {
		game.saveExtensionConfig(EXT, key, result);
		if (typeof game.yaoRefreshAllFupaoFx == "function") {
			game.yaoRefreshAllFupaoFx();
		}
	},
});
/** 通用音量项：只存盘，不需要重建特效 */
const volSetting = (key, name, init, intro) => ({
	name,
	init,
	// ★ 选项文字要短：.config.switcher > div 是 position:absolute + right:0，
	// 当前值是**右对齐绝对定位**的，名字或值任一过长就会跟它叠在一起。
	item: {
		0: "静音",
		"0.3": "30%",
		"0.5": "50%",
		"0.7": "70%",
		1: "100%",
		"1.5": "150%",
		2: "200%",
	},
	intro: `${intro}（音量系数。100% = 跟随游戏全局的「音效音量」，0 = 静音，可加到 200%）`,
	onclick(result) {
		game.saveExtensionConfig(EXT, key, result);
	},
});
/** 纯标题行（分支） */
const head = name => ({ name, clear: true, nopointer: true });
/** 说明行（不可点）。也要短，clear 行虽然能自动撑高，太长会换行不好看 */
const note = name => ({ name, clear: true, nopointer: true });

const SIZE_ITEM = {
	"0.6": "很小",
	"0.8": "偏小",
	1: "默认",
	"1.25": "偏大",
	1.5: "很大",
};
const SPEED_ITEM = {
	"0.5": "很慢",
	"0.75": "偏慢",
	1: "默认",
	1.5: "偏快",
	2: "很快",
};
// 金鱼大小单独一档：实机对比下来 1.2 最合适（比"偏大"再小一点点），所以档位加密了
const FISH_SIZE_ITEM = {
	"0.8": "偏小",
	"0.9": "略小",
	1: "默认",
	"1.1": "略大",
	"1.2": "推荐",
	"1.35": "偏大",
	1.5: "很大",
};
const FISH_OPACITY_ITEM = {
	"0.3": "30%",
	"0.5": "50%",
	"0.65": "65%",
	"0.8": "80%",
	"0.95": "95%",
	1: "100%",
};

const extensionPackage = {
	// 扩展名：同时是 extension_方舟_enable 这个配置项的键
	name: "方舟",
	// config：扩展自身的设置项，显示在「扩展 → 方舟」页面里
	config: {
		// ══ 遥 · 夏末游鳞 ══
		head_yao: head("<b>◆ 遥 · 夏末游鳞</b>"),
		head_yao_fx: head("　【浮泡】特效"),
		note_yao_fx: note("　　改完立即生效"),
		fx_size: {
			// input 项的输入框是右对齐 max-width 60%，名字更要短
			name: "　　球壳直径",
			init: "168",
			input: true,
			intro:
				"球壳直径是卡片宽度的百分之多少。卡片 120×200 时 168% ≈ 202px，" +
				"竖着正好从卡顶罩到卡底。建议 100 ~ 300，超出会自动回到 168。",
			onblur(e) {
				// input 项 UI 不会挂 clickToggle，只能自己在 onblur 里存盘
				let value = parseFloat(e.target.innerText);
				if (isNaN(value) || value < 60 || value > 600) {
					value = 168;
				}
				e.target.innerText = String(value);
				game.saveExtensionConfig(EXT, "fx_size", value);
				if (typeof game.yaoRefreshAllFupaoFx == "function") {
					game.yaoRefreshAllFupaoFx();
				}
			},
		},
		fx_shell: fxSetting(
			"fx_shell",
			"　　球壳浓度",
			1,
			{
				"0.7": "淡",
				1: "默认",
				"1.3": "浓",
				"1.6": "很浓",
			},
			"整层球壳的不透明度倍率。觉得泡泡太淡就往上调 —— 乘在整层 opacity 上，不改颜色。"
		),
		fx_glint: {
			name: "　　右上高光",
			init: true,
			intro: "球壳右上方那道弧形白光（原素材 tex\\haruka_07.png）。",
			onclick(result) {
				game.saveExtensionConfig(EXT, "fx_glint", result);
				if (typeof game.yaoRefreshAllFupaoFx == "function") {
					game.yaoRefreshAllFupaoFx();
				}
			},
		},
		fx_glint_scale: fxSetting(
			"fx_glint_scale",
			"　　高光大小",
			1,
			SIZE_ITEM,
			"那道白光的大小倍率。"
		),
		fx_fish_scale: fxSetting(
			"fx_fish_scale",
			"　　金鱼大小",
			"1.2",
			FISH_SIZE_ITEM,
			"整张鱼环图的缩放倍率。它同时改鱼的大小和贴合半径（鱼变大也会往外扩）。" +
				"对比下来 1.2 最合适，比「偏大」小一点点。"
		),
		fx_fish_opacity: fxSetting(
			"fx_fish_opacity",
			"　　金鱼透明度",
			"0.95",
			FISH_OPACITY_ITEM,
			"金鱼那一层的不透明度。嫌鱼抢眼就调低，想要更实就调到 100%。"
		),
		fx_fish_speed: fxSetting(
			"fx_fish_speed",
			"　　金鱼转速",
			1,
			SPEED_ITEM,
			"金鱼绕球心转一圈的速度倍率（默认 9 秒一圈）。"
		),
		fx_bubble_scale: fxSetting(
			"fx_bubble_scale",
			"　　气泡大小",
			1,
			SIZE_ITEM,
			"壳内壁那圈小白泡的大小倍率。默认只有球壳的 4.5%~6.5%，比鱼小得多。"
		),
		fx_bubble_speed: fxSetting(
			"fx_bubble_speed",
			"　　气泡速度",
			1,
			SPEED_ITEM,
			"小气泡往上飘一轮的速度倍率（默认 4~6 秒一轮）。"
		),
		fx_bubble_rise: fxSetting(
			"fx_bubble_rise",
			"　　气泡升高",
			9,
			{
				0: "0%",
				5: "5%",
				7: "7%",
				9: "9%",
				12: "12%",
				16: "16%",
			},
			"小气泡一轮往上飘多远，单位是球壳高度的百分之多少（默认 9%）。" +
				"想要完全不动就选 0%，那样它们只在原地淡入淡出。"
		),
		head_yao_vol: head("　【浮泡】音效"),
		fx_fupao_sfx: {
			name: "　　浮泡音效",
			init: true,
			intro: "浮泡生成 / 消失时播放的两条原始素材音效的总开关。",
			onclick(result) {
				game.saveExtensionConfig(EXT, "fx_fupao_sfx", result);
			},
		},
		vol_yao_fupao_on: volSetting(
			"vol_yao_fupao_on",
			"　　生成音量",
			"0.7",
			"球壳出现时播的 p_skill_wtrlimeboost（1.49s），比台词长，默认压到 70%。"
		),
		vol_yao_fupao_off: volSetting(
			"vol_yao_fupao_off",
			"　　消失音量",
			"0.7",
			"球壳消失时播的 p_skill_wtrlimedead（1.22s）。"
		),
		vol_yao_fuguang: volSetting(
			"vol_yao_fuguang",
			"　　台词音量",
			1,
			"【浮光】【幽萤】的台词，走引擎的 audio 字段随机播放。"
		),

		// ══ 结城理 · 月行水上 ══
		head_jycl: head("<b>◆ 结城理 · 月行水上</b>"),
		vol_jycl_swap: volSetting(
			"vol_jycl_swap",
			"　　换面具音效",
			1,
			"死亡换面具（①→②、②→③）时播的那条专用音效。"
		),
		vol_jycl_mianju: volSetting(
			"vol_jycl_mianju",
			"　　面具台词",
			1,
			"三张面具共用同一条「作战中」台词，发动技能时随机播放。"
		),

		// ══ 初雪 · 圣女 ══
		head_chuxue: head("<b>◆ 初雪 · 圣女</b>"),
		vol_cx_convert: volSetting(
			"vol_cx_convert",
			"　转换技音效",
			1,
			"【祈愿】在雪境 / 圣山两个形态之间转换时播的专用音效。"
		),
		vol_cx_attack: volSetting(
			"vol_cx_attack",
			"　出杀音效",
			1,
			"【霜涛】触发衍生【杀】时播的专用音效。"
		),
		vol_cx_taici: volSetting(
			"vol_cx_taici",
			"　台词音量",
			1,
			"雪景 / 祈愿 / 圣山 / 霜涛四个技能的台词。"
		),

		// ══ 维什戴尔 · 绝对主角 ══
		head_wsde: head("<b>◆ 维什戴尔 · 绝对主角</b>"),
		vol_wsde_taici: volSetting(
			"vol_wsde_taici",
			"　台词音量",
			1,
			"余震 / 魂影 / 黎明三个技能的台词。"
		),
		note_wsde: note("　　（无专用音效）"),

		// ══ 逻各斯 · 女妖之主 ══
		head_logos: head("<b>◆ 逻各斯 · 女妖之主</b>"),
		vol_logos_taici: volSetting(
			"vol_logos_taici",
			"　台词音量",
			1,
			"【提喻】【殁亡】的台词。两个技能共用同一组 7 条语音，发动时随机播一条。"
		),
		note_logos: note("　　（无专用音效）"),

		// ══ 安洁莉娜 · 酸橙的心意 ══
		head_ajln: head("<b>◆ 安洁莉娜 · 酸橙的心意</b>"),
		vol_ajln_taici: volSetting(
			"vol_ajln_taici",
			"　台词音量",
			1,
			"【重力自定义】的台词（作战中1~4 / 部署1~2，共 6 条，发动时随机一条）。"
		),
		note_ajln: note("　　（无专用音效）"),

		// ══ 华法琳 · 实验狂魔 ══
		head_hfl: head("<b>◆ 华法琳 · 实验狂魔</b>"),
		vol_hfl_taici: volSetting(
			"vol_hfl_taici",
			"　台词音量",
			1,
			"【血浆】【实验】的台词。两个技能共用同一组 6 条语音，发动时随机播一条。"
		),
		note_hfl: note("　　（无专用音效）"),

		// ══ 乌啾 · 羽隐愈疗 ══
		head_wj: head("<b>◆ 乌啾 · 羽隐愈疗</b>"),
		vol_wj_taici: volSetting(
			"vol_wj_taici",
			"　台词音量",
			1,
			"【捉迷藏】【迷彩】【保身】的台词。三个技能共用同一组 5 条语音，发动时随机播一条。"
		),
		note_wj: note("　　（无专用音效）"),

		// ══ 煌 · 好兄弟 ══
		head_huang: head("<b>◆ 煌 · 好兄弟</b>"),
		vol_huang_taici: volSetting(
			"vol_huang_taici",
			"　台词音量",
			1,
			"【链锯】【除颤】【过载】的台词（作战中1~4 / 选中干员1~2 / 部署1~2，共 8 条）。" +
				"【沸腾】【爆裂】是过载「视为拥有」的锁定技，不单独配台词。"
		),
		note_huang: note("　　（无专用音效）"),

		// ══ 好运煌 ══
		head_hlucky: head("<b>◆ 好运煌</b>"),
		vol_hlucky_taici: volSetting(
			"vol_hlucky_taici",
			"　台词音量",
			1,
			"【链锯】【除颤】【过载】的台词（与煌同一批素材、单独存了一份副本，共 8 条）。" +
				"【沸腾】【爆裂】是过载「视为拥有」的锁定技，不单独配台词。"
		),
		note_hlucky: note("　　（无专用音效）"),

		// ══ 涤火杰西卡 · 流泪猫猫头 ══
		head_dhjxk: head("<b>◆ 涤火杰西卡 · 流泪猫猫头</b>"),
		note_dhjxk: note("　　（七个技能都没有配音素材，全部走静音）"),

		// ══ 琪露诺 · 湖上的冰精 ══
		head_qlno: head("<b>◆ 琪露诺 · 湖上的冰精</b>"),
		note_qlno: note("　　（两个技能都没有配音素材，全部走静音）"),

		// ══ 藿藿 · 令奉贞凶 ══
		head_huohuo: head("<b>◆ 藿藿 · 令奉贞凶</b>"),
		vol_huohuo_taici: volSetting(
			"vol_huohuo_taici",
			"　台词音量",
			1,
			"【护命】【尾巴】【凭依】的台词（护命 3 条 / 尾巴 3 条 / 凭依 1 条，各按序号随机播放）。"
		),
		note_huohuo: note("　　（无专用音效）"),

		// ══ 均（相见欢 / 律法）· 重岳 · 颉 · 黍 ══
		head_jun: head("<b>◆ 均 · 相见欢　/　均 · 律法</b>"),
		note_jun: note("　　（两个均是同名的独立武将，storage 键各带 xjh_ / lf_ 前缀）"),
		note_jun2: note("　　（六个技能都没有配音素材，全部走静音）"),
		head_zy: head("<b>◆ 重岳 · 登临意</b>"),
		note_zy: note("　　（无配音素材）"),
		head_jie: head("<b>◆ 颉 · 辞岁行</b>"),
		note_jie: note("　　（无配音素材；【诀别】按作者意见暂未实现）"),
		head_shu: head("<b>◆ 黍 · 怀黍离</b>"),
		note_shu: note("　　（无配音素材）"),

		// ══ 塔露拉 · 年 ══
		head_tll: head("<b>◆ 塔露拉 · 不死的黑蛇</b>"),
		note_tll: note("　　（三个技能都没有配音素材，全部走静音；觉醒后卡面会自动换成觉醒后立绘）"),
		head_nian: head("<b>◆ 年 · 洪炉示岁</b>"),
		note_nian: note("　　（三个技能都没有配音素材，全部走静音）"),

		// ══ 在线更新 ══
		// 具体实现见 main/update.js。这里只放一个地址输入框和两个动作按钮。
		//
		// ★ clear: true 的项在引擎里走的是另一条分支（ui/create/menu/index.js 的
		//   `else` 分支）：它会渲染 config.name 当文字并挂上点击，但**不会**设置
		//   intro 悬停提示。所以按钮的说明只能写在旁边的 note 行里。
		//   而 onclick 拿到的是「开关有没有被点亮」，返回 false 就会把这个状态撤回，
		//   于是它看起来就是个按一下执行、不会留住高亮的按钮。
		head_update: head("<b>◆ 在线更新</b>"),
		note_update_ver: note(`　　当前版本 ${extensionInfo.version}`),
		update_repo: {
			name: "　　更新源",
			// input 项的显示值直接取 config.init，引擎不会去读存档
			// （`input.innerHTML = config.init`），所以这里先把存档里的值取出来；
			// 用户改完在 onblur 里写回 init，免得下次进来还显示旧地址。
			init: getRepoSpec(),
			input: true,
			intro:
				"格式是 `用户名/仓库名@分支`，例如 " +
				DEFAULT_REPO +
				"。换源、换分支，或者指向别人 fork 的一份都改这里。" +
				"下载会依次尝试 ghproxy.net → gh-proxy.com → ghfast.top → GitHub 直连。",
			onblur(e) {
				const value = String(e.target.innerText || "").replace(/<br>/g, "").trim();
				if (!value || !parseRepoSpec(value)) {
					e.target.innerText = getRepoSpec();
					alert(`更新源格式不对：${value || "(空)"}\n\n应该长这样：用户名/仓库名@分支\n例如 ${DEFAULT_REPO}`);
					return;
				}
				e.target.innerText = value;
				game.saveExtensionConfig(EXT, "update_repo", value);
				extensionPackage.config.update_repo.init = value;
			},
		},
		btn_update: {
			name: "　　【检查更新】",
			clear: true,
			onclick() {
				checkAndUpdate(false);
				return false;
			},
		},
		btn_update_force: {
			name: "　　【强制校验】",
			clear: true,
			onclick() {
				checkAndUpdate(true);
				return false;
			},
		},
		note_update_tip: note("　　发现新版会先列出文件再问你要不要装"),
		note_update_tip2: note("　　「强制校验」= 忽略版本号重算全部 MD5"),
		note_update_tip3: note("　　更新完会自动刷新界面，请先结束当前对局"),
	},
	// content / precontent：扩展加载时执行的两个钩子（见 main/ 目录）
	content,
	precontent,
	// connect: true = 允许本扩展在联机模式下加载。
	// 引擎在联机模式加载扩展时会跳过未标记 connect 的扩展的 content 钩子
	// （见 init/loading.js 的 loadExtension），联机时本扩展就会「装了但没生效」。
	connect: true,
	// help：显示在扩展帮助里的内容
	help: {},
	// package：扩展信息（作者/版本/介绍），下面从 info.json 复制
	package: {},
	// files：扩展包含的资源文件清单（扩展编辑器/分享时使用）
	files: {
		character: [
			"wsde_weisidaier.png",
			"cx_chuxue.png",
			"yao_yao.png",
			"lgs_logos.png",
			"jycl_makoto1.png",
			"jycl_makoto2.png",
			"jycl_makoto3.png",
			// 普瑞赛斯：①立绘 ②立绘（②是内部武将牌，只在①死亡换牌后出现）
			"prss_priestess1.png",
			"prss_priestess2.png",
			// 夕：立绘是 jpg（其余干员都是 png）
			"dusk_xi.jpg",
			// 蓬莱山辉夜：立绘同样是 jpg
			"kaguya.jpg",
			// 安洁莉娜 / 华法琳 / 乌啾 / 煌
			"ajln_angelina.png",
			"hfl_warfarin.png",
			"wj_wujiu.png",
			"huang_blaze.png",
			// 好运煌：与煌共用同一张立绘素材（素材目录里只有煌那一张），
			// 但仍然**单独存一份文件** —— 各指各的，以后换图不会互相牵连
			"hlucky_huang.png",
			// 涤火杰西卡
			"dhjxk_jessica.png",
			// 琪露诺：素材真名是「湖上的冰精.琪露诺-原画.png」，但它其实是 JPEG
			// （文件头 FF D8 FF E0），所以按实际格式存成 .jpg，
			// 与 dusk_xi / kaguya 走同一个 jpg 分支。
			"qlno_cirno.jpg",
			// 均（相见欢）：素材真名是「立绘<U+200B>.jpg」，「绘」后面夹了一个
			// 零宽空格（U+200B），搬运时按扩展惯例改名成 <武将id>.jpg
			"xjh_jun.jpg",
			// 均（律法）：png
			"lf_jun.png",
			// 颉：jpg
			"jie_xie.jpg",
			// 塔露拉：素材给了「觉醒前立绘.png」和「觉醒后立绘.png」两张，
			// 前者写进 character.js 的 img，后者由【黑蛇】觉醒时直接换 DOM
			"tll_talula.png",
			"tll_talula_awake.png",
			// 年：素材真名是「立绘<U+200B>.png」，同 xjh_jun 一样夹着零宽空格
			"nian_nian.png",
			// 重岳 / 黍：立绘是后补的，素材真名同样夹着零宽空格
			"zy_chongyue.png",
			"shu_shu.png",
			// 陈：素材真名「立绘<U+200B>.png」，同样夹着零宽空格
			"chen_chen.png",
			// 藿藿：素材真名是「立绘.jpg」，按扩展惯例改成 <武将id>.jpg
			"hh_huohuo.jpg",
		],
		// 衍生卡牌图。辉夜的十张「神宝」不放进引擎的 image/card/
		// （那是引擎自己的目录），而是走扩展自己的 image/card/，
		// 在 card.js 里用每张卡的 image 字段指过去。
		// 升级前 / 升级后各五张，前者的图是原素材灰度泛黄处理过的。
		card: [
			"image/card/kgy_danzhi.png",
			"image/card/kgy_yuzhi.png",
			"image/card/kgy_longyu.png",
			"image/card/kgy_yaolongyu.png",
			"image/card/kgy_zianbei.png",
			"image/card/kgy_shengmingquan.png",
			"image/card/kgy_foyushi.png",
			"image/card/kgy_jingangshi.png",
			"image/card/kgy_piyi.png",
			"image/card/kgy_huoxiyi.png",
			// 颉的衍生武器牌【书刀】：素材是同目录下的「书刀.jpg」，
			// 是一张 1440×1055 的 JPEG，所以按实际格式存成 .jpg
			"image/card/jie_shudao.jpg",
		],
		skill: [
			"skill/wsde_yuzhen1.mp3",
			"skill/wsde_yuzhen2.mp3",
			"skill/wsde_yuzhen3.mp3",
			"skill/wsde_hunying1.mp3",
			"skill/wsde_hunying2.mp3",
			"skill/wsde_hunying3.mp3",
			"skill/wsde_liming1.mp3",
			"skill/wsde_liming_sha1.mp3",
			"skill/cx_xuejing1.mp3",
			"skill/cx_xuejing2.mp3",
			"skill/cx_xuejing3.mp3",
			"skill/cx_qiyuan1.mp3",
			"skill/cx_qiyuan2.mp3",
			"skill/cx_shengshan1.mp3",
			"skill/cx_shengshan2.mp3",
			"skill/cx_shuangtao1.mp3",
			"skill/cx_shuangtao2.mp3",
			"skill/yao_fuguang1.mp3",
			"skill/yao_fuguang2.mp3",
			"skill/yao_fuguang3.mp3",
			"skill/yao_youying1.mp3",
			"skill/yao_youying2.mp3",
			"skill/yao_youying3.mp3",
			"skill/yao_youying4.mp3",
			// 逻各斯：提喻 / 殁亡 共用作者给的同一组 7 条语音
			//（作战中1~4、选中干员2、部署1、部署2），各复制一份是因为引擎按
			// 「技能名+序号.mp3」找文件（见 get/audio.js 的 textMapWithIndex）
			"skill/lgs_tiyu1.mp3",
			"skill/lgs_tiyu2.mp3",
			"skill/lgs_tiyu3.mp3",
			"skill/lgs_tiyu4.mp3",
			"skill/lgs_tiyu5.mp3",
			"skill/lgs_tiyu6.mp3",
			"skill/lgs_tiyu7.mp3",
			"skill/lgs_mowang1.mp3",
			"skill/lgs_mowang2.mp3",
			"skill/lgs_mowang3.mp3",
			"skill/lgs_mowang4.mp3",
			"skill/lgs_mowang5.mp3",
			"skill/lgs_mowang6.mp3",
			"skill/lgs_mowang7.mp3",
			// 结城理：三张面具共用同一组四条语音（作战中1~4），各留一份副本
			// 是因为引擎按「技能名+序号.mp3」找文件（见 get/audio.js 的 textMapWithIndex）
			"skill/jycl_mianju_a1.mp3",
			"skill/jycl_mianju_a2.mp3",
			"skill/jycl_mianju_a3.mp3",
			"skill/jycl_mianju_a4.mp3",
			"skill/jycl_mianju_b1.mp3",
			"skill/jycl_mianju_b2.mp3",
			"skill/jycl_mianju_b3.mp3",
			"skill/jycl_mianju_b4.mp3",
			"skill/jycl_mianju_c1.mp3",
			"skill/jycl_mianju_c2.mp3",
			"skill/jycl_mianju_c3.mp3",
			"skill/jycl_mianju_c4.mp3",
			// 专用音效（不是台词，用 game.playAudio 直接播单个文件）
			"skill/切换为面具.mp3",
			"skill/转换技音效.mp3",
			"skill/攻击音效.mp3",
			// 浮泡的生成 / 消失：遥二技能的原始素材（WAV，未转码）
			"skill/浮泡生成.wav",
			"skill/浮泡消失.wav",
			// 安洁莉娜：6 条（作战中1~4 / 部署1~2）。
			// 只有【重力自定义】一个技能，所以原样复制一份即可。
			"skill/ajln_zhongli1.mp3",
			"skill/ajln_zhongli2.mp3",
			"skill/ajln_zhongli3.mp3",
			"skill/ajln_zhongli4.mp3",
			"skill/ajln_zhongli5.mp3",
			"skill/ajln_zhongli6.mp3",
			// 华法琳：6 条，【血浆】【实验】各留一份副本
			// （引擎按「技能名+序号.mp3」找文件，见 get/audio.js 的 textMapWithIndex）
			"skill/hfl_xuejiang1.mp3",
			"skill/hfl_xuejiang2.mp3",
			"skill/hfl_xuejiang3.mp3",
			"skill/hfl_xuejiang4.mp3",
			"skill/hfl_xuejiang5.mp3",
			"skill/hfl_xuejiang6.mp3",
			"skill/hfl_shiyan1.mp3",
			"skill/hfl_shiyan2.mp3",
			"skill/hfl_shiyan3.mp3",
			"skill/hfl_shiyan4.mp3",
			"skill/hfl_shiyan5.mp3",
			"skill/hfl_shiyan6.mp3",
			// 乌啾：5 条（作战中1~4 / 选中干员1），三个技能各留一份副本
			"skill/wj_zhuomicang1.mp3",
			"skill/wj_zhuomicang2.mp3",
			"skill/wj_zhuomicang3.mp3",
			"skill/wj_zhuomicang4.mp3",
			"skill/wj_zhuomicang5.mp3",
			"skill/wj_micai1.mp3",
			"skill/wj_micai2.mp3",
			"skill/wj_micai3.mp3",
			"skill/wj_micai4.mp3",
			"skill/wj_micai5.mp3",
			"skill/wj_baoshen1.mp3",
			"skill/wj_baoshen2.mp3",
			"skill/wj_baoshen3.mp3",
			"skill/wj_baoshen4.mp3",
			"skill/wj_baoshen5.mp3",
			// 煌：8 条（作战中1~4 / 选中干员1~2 / 部署1~2），三个技能各留一份副本
			"skill/huang_lianju1.mp3",
			"skill/huang_lianju2.mp3",
			"skill/huang_lianju3.mp3",
			"skill/huang_lianju4.mp3",
			"skill/huang_lianju5.mp3",
			"skill/huang_lianju6.mp3",
			"skill/huang_lianju7.mp3",
			"skill/huang_lianju8.mp3",
			"skill/huang_chuchan1.mp3",
			"skill/huang_chuchan2.mp3",
			"skill/huang_chuchan3.mp3",
			"skill/huang_chuchan4.mp3",
			"skill/huang_chuchan5.mp3",
			"skill/huang_chuchan6.mp3",
			"skill/huang_chuchan7.mp3",
			"skill/huang_chuchan8.mp3",
			"skill/huang_guozai1.mp3",
			"skill/huang_guozai2.mp3",
			"skill/huang_guozai3.mp3",
			"skill/huang_guozai4.mp3",
			"skill/huang_guozai5.mp3",
			"skill/huang_guozai6.mp3",
			"skill/huang_guozai7.mp3",
			"skill/huang_guozai8.mp3",
			// 好运煌：与煌同一批 8 条素材，三个技能各留一份副本
			// （引擎只认 `<技能名><序号>.mp3`，不认软链接、也不共享）
			"skill/hlucky_lianju1.mp3",
			"skill/hlucky_lianju2.mp3",
			"skill/hlucky_lianju3.mp3",
			"skill/hlucky_lianju4.mp3",
			"skill/hlucky_lianju5.mp3",
			"skill/hlucky_lianju6.mp3",
			"skill/hlucky_lianju7.mp3",
			"skill/hlucky_lianju8.mp3",
			"skill/hlucky_chuchan1.mp3",
			"skill/hlucky_chuchan2.mp3",
			"skill/hlucky_chuchan3.mp3",
			"skill/hlucky_chuchan4.mp3",
			"skill/hlucky_chuchan5.mp3",
			"skill/hlucky_chuchan6.mp3",
			"skill/hlucky_chuchan7.mp3",
			"skill/hlucky_chuchan8.mp3",
			"skill/hlucky_guozai1.mp3",
			"skill/hlucky_guozai2.mp3",
			"skill/hlucky_guozai3.mp3",
			"skill/hlucky_guozai4.mp3",
			"skill/hlucky_guozai5.mp3",
			"skill/hlucky_guozai6.mp3",
			"skill/hlucky_guozai7.mp3",
			"skill/hlucky_guozai8.mp3",
			// 陈：作战中1~4 拆成绝影 / 拔刀各两条，部署1~2 给形照
			"skill/chen_jueying1.mp3",
			"skill/chen_jueying2.mp3",
			"skill/chen_badao1.mp3",
			"skill/chen_badao2.mp3",
			"skill/chen_xingzhao1.mp3",
			"skill/chen_xingzhao2.mp3",
			// 藿藿：护命 3 条（一技能1~3）/ 尾巴 3 条（二技能 系列）/ 凭依 1 条（三技能）
			"skill/hh_huming1.mp3",
			"skill/hh_huming2.mp3",
			"skill/hh_huming3.mp3",
			"skill/hh_weiba1.mp3",
			"skill/hh_weiba2.mp3",
			"skill/hh_weiba3.mp3",
			"skill/hh_pingyi1.mp3",
		],
		audio: [],
		// 特效贴图（CSS 里用 url() 引用，不能放 skill/ 下，那边是音频目录）
		// yao_fupao_shell  = 原素材 素材\遥\浮泡.png，球壳本体（香皂泡）
		// yao_fupao_fish   = 原素材 素材\遥\游鱼.png，沿球壳边缘弯好的鱼环
		// yao_fupao_bubble = 原素材 tex\bubble_01.png，壳内壁的小气泡（3×3 序列帧）
		// yao_fupao_glint  = 原素材 tex\haruka_07.png，右上角三道弧形白光
		image: [
			"image/yao_fupao_shell.png",
			"image/yao_fupao_fish.png",
			"image/yao_fupao_bubble.png",
			"image/yao_fupao_glint.png",
		],
	},
};

Object.keys(extensionInfo)
	.filter(key => key !== "name")
	.forEach(key => {
		extensionPackage.package[key] = extensionInfo[key];
	});

// type 必须导出，引擎靠它分辨这是扩展还是角色包/卡牌包
export let type = "extension";
export default extensionPackage;
