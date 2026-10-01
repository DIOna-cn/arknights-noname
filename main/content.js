import { game, lib } from "noname";

// 扩展启用后执行（比 precontent 晚，此时本体的包都已经加载完毕）
//
// 这里只做一件事：把本扩展的**台词音量**接进「扩展 → 方舟」的设置。
// 技能台词是引擎按 audio 字段自己播的（game.trySkillAudio → game.tryAudio → game.playAudio），
// 我们拿不到播放时机，但 game.playAudio 会把建好的 <audio> 返回，
// 所以在外面包一层、按路径认出"这是我们扩展的文件"再改一次 volume 就行。
// 台词本身走 lib.config.volumn_audio / 8（游戏全局的「音效音量」），这里只是再乘一个系数。
//
// 只碰路径里带 `方舟/skill/` 的音频，其它一律原样返回；
// 专用音效（切换为面具 / 转换技音效 / 攻击音效 / 浮泡生成 / 浮泡消失）文件名不带这些前缀，
// 不会被这里命中，它们由 skill.js 的 playSfx 自己设音量。
const VOICE_VOLUME = [
	{ test: /方舟\/skill\/wsde_/, key: "vol_wsde_taici" },
	{ test: /方舟\/skill\/cx_/, key: "vol_cx_taici" },
	{ test: /方舟\/skill\/yao_/, key: "vol_yao_fuguang" },
	{ test: /方舟\/skill\/jycl_mianju_/, key: "vol_jycl_mianju" },
	// 逻各斯：提喻 / 殁亡 共用同一组 7 条语音（各复制了一份同序号的副本）
	{ test: /方舟\/skill\/lgs_/, key: "vol_logos_taici" },
	// 安洁莉娜 / 华法琳 / 乌啾 / 煌：也各复制了一份同序号的副本，
	// 所以按**技能名前缀**分组即可（几个技能共用同一条音量）
	{ test: /方舟\/skill\/ajln_/, key: "vol_ajln_taici" },
	{ test: /方舟\/skill\/hfl_/, key: "vol_hfl_taici" },
	{ test: /方舟\/skill\/wj_/, key: "vol_wj_taici" },
	{ test: /方舟\/skill\/huang_/, key: "vol_huang_taici" },
	// 好运煌：和煌是两个独立武将，语音也各存了一份副本，所以另配一条前缀规则
	// （`huang_` 匹配不到 `hlucky_`，两条互不干扰）
	{ test: /方舟\/skill\/hlucky_/, key: "vol_hlucky_taici" },
];

function voiceScale(parsedPath) {
	if (!parsedPath || parsedPath.indexOf("方舟/skill/") < 0) {
		return null;
	}
	const rule = VOICE_VOLUME.find(item => item.test.test(parsedPath));
	if (!rule) {
		return null;
	}
	const value = parseFloat(lib.config[`extension_方舟_${rule.key}`]);
	return isNaN(value) ? 1 : Math.max(0, Math.min(2, value));
}

export function content(config, pack) {
	// ── 把【提喻】的封印技注册成**全局技能** ──────────────────────
	//
	// 为什么必须是全局的：cardEnabled2 / cardDiscardable / canBeDiscarded
	// 最后都走 game.checkMod(card, player, ..., <技能拥有者>)，而「技能拥有者」
	// 是**正在用牌的那个人**（见 library/index.js 的 lib.filter）。
	// 所以 mod 不能挂在逻各斯身上。
	//
	// 第一版的做法是「黑色效果命中时给目标 player.addSkill('lgs_tiyu_seal')」，
	// 游戏里没生效。改成全局技能后这条路彻底不需要了：
	//   game.checkMod → player.getModableSkills() → getSkills().concat(lib.skill.global)
	// 全局技能出现在**每个人**的 mod 列表里，于是不管那张牌在谁手上都会被拦。
	//
	// 顺带还有两个好处：
	//   · 不依赖 addSkill 的调用时机（_status.event / clearStepCache 那一串）；
	//   · 到期不需要给每个人 removeSkill，只要把牌上的 gaintag 清掉即可。
	//
	// ⚠ 但这**不是**可靠的注册点：扩展的 content 钩子跑在「扩展加载」阶段，
	//   那时角色包还只是躺在 lib.imported.character 里，要等模式加载调
	//   loadCharacter 才合并进 lib.skill，所以这里很可能因为
	//   lib.skill.lgs_tiyu_seal 还不存在而静默失败（addGlobalSkill 内部
	//   `if (!info) return false`）。
	//   **真正的保险在 lgs_tiyu.content() 开头**（那时游戏已在跑）。
	//   两处都留着，addGlobalSkill 是幂等的。
	if (lib.skill?.lgs_tiyu_seal) {
		game.addGlobalSkill("lgs_tiyu_seal");
	}

	// ── 把辉夜【难题】里针对其他角色那几条注册成**全局技能** ─────
	//
	// 理由与上面的 lgs_tiyu_seal 完全一样：cardEnabled2 / cardDiscardable /
	// canBeDiscarded / maxHandcard 最后都走 game.checkMod(..., <技能拥有者>)，
	// 而「技能拥有者」是**正在行动的那个人**，挂到辉夜身上封不住别人。
	//
	// ⚠ 同样不是可靠的注册点（content 跑在扩展加载阶段，那时角色包还没 loadCharacter，
	//   lib.skill.kgy_nanti_rule 多半还不存在）。真正的保险在 kgy_nanti 的 init() 里，
	//   也就是玩家实际拿到【难题】的那一刻。两处都留着，addGlobalSkill 是幂等的。
	if (lib.skill?.kgy_nanti_rule) {
		game.addGlobalSkill("kgy_nanti_rule");
	}

	// ── 【面具】卖血时不让 AI 用【桃】/【酒】把自己救回来 ──────────
	//
	// 结城理三张面具的体力上限都是 1：主动「失去 1 点体力」= 当场打进濒死
	// = 触发 dieBefore 换下一张面具（顺带回满）。但引擎的濒死流程会**先问所有人
	// 要不要用【桃】/【酒】救他**（见 library/element/content.js 的 _save），
	// AI 结城理自己往往会掏一张【桃】把自己拉回 1 血 —— 面具没换成，还白掉 1 点体力。
	//
	// 官方给 AI 准备的排除口子是 `lib.filter.cardAiIncluded`（它读当前事件的
	// `_aiexclude`），但那个事件是 `_save` 内部现建的 chooseToUse，外面拿不到引用。
	// 所以这里退一步，包装求桃用的 `lib.filter.cardSavable`：
	// 只在「濒死的人正是卖血中的本人」**且**「这一下由 AI 决策」时才拦，
	// 人类玩家自己点【桃】/【酒】自救完全不受影响。
	//
	// 标记 `jycl_selling` 由 jycl_mianju_a / _b 的 content 在 loseHp 前后设置。
	if (!game.__arknightsSaveHooked && lib.filter?.cardSavable) {
		game.__arknightsSaveHooked = true;
		const cardSavable = lib.filter.cardSavable;
		lib.filter.cardSavable = function (card, player, dying) {
			if (!cardSavable.apply(this, arguments)) {
				return false;
			}
			if (dying && player === dying && dying.storage?.jycl_selling && !dying.isMine()) {
				return false;
			}
			return true;
		};
	}

	// 只包一次（扩展被重新启用时 content 会再跑一遍）
	if (game.__arknightsVoiceHooked) {
		return;
	}
	game.__arknightsVoiceHooked = true;
	const playAudio = game.playAudio;
	game.playAudio = function (...args) {
		const audio = playAudio.apply(this, args);
		if (!audio || typeof audio.volume != "number") {
			return audio;
		}
		const raw = args.length === 1 && args[0] && typeof args[0] == "object" ? args[0].path : args[0];
		if (typeof raw != "string") {
			return audio;
		}
		// 和 game.playAudio 内部同一套换算，才能拿到它实际用的路径
		const parsedPath = raw.startsWith("ext:") ? raw.replace(/^ext:/, "extension/") : raw;
		const scale = voiceScale(parsedPath);
		if (scale === null) {
			return audio;
		}
		audio.volume = Math.max(0, Math.min(1, (lib.config.volumn_audio / 8) * scale));
		return audio;
	};
}
