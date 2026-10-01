import { game, get } from "noname";

// ══════════════════════════════════════════════════════════════════
// 「神宝」——蓬莱山辉夜（kaguya）的十张衍生装备牌
//
// 十张牌其实是**五件宝物的两个形态**（升级前 → 升级后）：
//     蓬莱的弹枝 → 蓬莱的玉枝          龙颈之玉 → 耀眼的龙玉
//     燕的子安贝 → 无限的生命之泉      佛御石之钵 → 佛体的金刚石
//     火鼠的皮衣 → 火蜥蜴之盾
//
// 升级前的卡图是原素材**灰度 + 泛黄**处理过的（老照片那种暖黄），
// 升级后的卡图是原图 —— 一眼就能看出哪件升过级。
// 处理脚本见 E:\Deepseek\_work\make-kaguya-art.ps1。
//
// ★ 这十张牌**不进 lib.card.list**，也就是不会出现在初始牌堆里。
//   开局那五张由【难题】在 gameStart 时用 game.createCard2 造出来，
//   再随机插进 ui.cardPile（见 skill.js 的 kgy_nanti）。
// ══════════════════════════════════════════════════════════════════

/**
 * 升级表：升级前 → 升级后。
 * 键的顺序就是开局洗进牌堆的那五张的顺序。
 */
const KGY_SHENBAO_UPGRADE = {
	kgy_danzhi: "kgy_yuzhi",
	kgy_longyu: "kgy_yaolongyu",
	kgy_zianbei: "kgy_shengmingquan",
	kgy_foyushi: "kgy_jingangshi",
	kgy_piyi: "kgy_huoxiyi",
};

/** 开局洗进牌堆的五张（都是升级前的形态） */
const KGY_SHENBAO_BASE = Object.keys(KGY_SHENBAO_UPGRADE);

/** 全部十张神宝（升级前 + 升级后） */
const KGY_SHENBAO = [...KGY_SHENBAO_BASE, ...Object.values(KGY_SHENBAO_UPGRADE)];

/**
 * 十张神宝的装备技能名。
 * 【永夜归反 -世间开明-】要用它整批调 player.refreshSkill，
 * 所以单独留一份，免得两处各写一遍写岔。
 */
const KGY_SHENBAO_SKILLS = KGY_SHENBAO.map(name => `${name}_skill`);

/** 这张牌是不是「神宝」。传卡牌对象或卡名都行。 */
function kgyIsShenbao(card) {
	if (!card) {
		return false;
	}
	return KGY_SHENBAO.includes(typeof card == "string" ? card : card.name);
}

// ── 卡牌 ────────────────────────────────────────────────────────────

/**
 * 卡图路径。
 *
 * 引擎默认只会去找 `image/card/<卡名>.png` —— 那是**引擎自己的**目录，
 * 扩展的图不能往那儿放，所以必须显式写 `image` 字段。
 * setBackgroundImage 会自动补上 lib.assetURL，写相对于 app 根目录的路径即可。
 */
const equipImage = name => `extension/方舟/image/card/${name}.png`;

/**
 * 神宝卡的公共字段。
 *
 * ★ 不用 fullskin。这里的素材是带透明通道的小图标（96×92 ~ 186×186），
 *   fullskin 会把图拉满整张卡（120×200），糊得没法看；
 *   不用 fullskin 时引擎会把图放进卡面中央的图片区，尺寸刚好。
 */
function kgyCard(name, equipValue) {
	return {
		type: "equip",
		// equip5 = 宝物栏（见 library/index.js 的 lib.translate.equip5）
		subtype: "equip5",
		image: equipImage(name),
		skills: [`${name}_skill`],
		// 归入「衍生卡」分类：loadCharacter 见到 derivation 会把它
		// 放进 lib.cardPack.mode_derivation，卡牌图鉴里就能看到
		derivation: "kaguya",
		ai: { basic: { equipValue } },
	};
}

const cards = {
	kgy_danzhi: kgyCard("kgy_danzhi", 6),
	kgy_yuzhi: kgyCard("kgy_yuzhi", 8),
	kgy_longyu: kgyCard("kgy_longyu", 5),
	kgy_yaolongyu: kgyCard("kgy_yaolongyu", 7),
	kgy_zianbei: kgyCard("kgy_zianbei", 5),
	kgy_shengmingquan: kgyCard("kgy_shengmingquan", 7),
	kgy_foyushi: kgyCard("kgy_foyushi", 5),
	// 金刚石除了「不可被响应」还挂了伤害 +1 的子技能，所以 skills 要写两张
	kgy_jingangshi: Object.assign(kgyCard("kgy_jingangshi", 8), {
		skills: ["kgy_jingangshi_skill", "kgy_jingangshi_damage"],
	}),
	kgy_piyi: kgyCard("kgy_piyi", 6),
	kgy_huoxiyi: kgyCard("kgy_huoxiyi", 9),

	// ── 【书刀】（颉的衍生武器牌）─────────────────────────────────
	//
	// ★ 这张牌**永远不在任何区域里**：颉的【书刀】是「视为装备着」，
	//   走的是引擎的 extraEquip 机制（同〖藤甲〗的 addExtraEquip），
	//   也就是凭空占一个装备栏位的虚拟装备。所以它留在这里只为了三件事：
	//     ① 让装备栏显示得出名字与类型（$handleEquipChange 读 get.translation /
	//        get.subtype）；
	//     ② 让卡牌图鉴里查得到这张牌；
	//     ③ 记下攻击距离 —— 但虚拟装备不会被 getEquipRange 读到，
	//        所以真正生效的距离加成写在 skill.js 里 jie_shudao 的 mod.attackRange。
	//   「不可被移除」同样是白送的：根本没有实体牌可以被弃置、被拿走或被替换。
	//
	// ★ 卡图是素材目录里的「书刀.jpg」（一张 1440×1055 的玉刀图，JPEG），
	//   不是 png —— 引擎的 image 字段是显式路径，所以格式随意。
	jie_shudao: {
		type: "equip",
		subtype: "equip1",
		// 攻击距离 2 == attackFrom -1（见 library/element/player.js 的 getEquipRange）
		distance: { attackFrom: -1 },
		image: "extension/方舟/image/card/jie_shudao.jpg",
		// 装备技能由武将技能（jie_shudao 的 group）提供，虚拟装备本身不挂技能
		skills: [],
		derivation: "jie_xie",
		ai: {
			basic: {
				equipValue: 4,
			},
		},
	},
};

// ── 装备技能 ────────────────────────────────────────────────────────
//
// 「每回合限一次 / 两次」一律用引擎自带的 usable —— 它数的是
// player.getStat("triggerSkill")[技能名]，而这份计数在**每个角色的回合开始**
// 都会被清空（见 content.js 的 phaseLoop 里那个
// `current.stat.push({card:{},skill:{},triggerSkill:{}})` 循环）。
// 所以 usable: 1 的语义正好就是「每回合限一次」，
// 【永夜归反 -世间开明-】也才能用 player.refreshSkill 把它整批重置。
//
// ★ 技能的 usable 只作用于 trigger 部分；同一个技能里的 mod 不受影响。

/** 锁定技，使用【杀】无次数限制 + 每回合限 N 次使用【杀】时摸一张 */
function kgyShaDrawSkill(usable, unlimitedRange) {
	const mod = {
		cardUsable(card, player, num) {
			if (card.name == "sha") {
				return Infinity;
			}
		},
	};
	if (unlimitedRange) {
		mod.targetInRange = function (card, player, target) {
			if (card.name == "sha") {
				return true;
			}
		};
	}
	return {
		equipSkill: true,
		audio: false,
		locked: true,
		forced: true,
		mod,
		usable,
		trigger: { player: "useCard" },
		filter(event, player) {
			return event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			await player.draw(1);
		},
	};
}

/** 锁定技，使用的【杀】不可被响应（+可选：伤害 +1） */
function kgyShaDirectHitSkill(withDamageBonus) {
	const skill = {
		equipSkill: true,
		audio: false,
		locked: true,
		forced: true,
		trigger: { player: "useCard" },
		filter(event, player) {
			return event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			trigger.directHit.addArray(trigger.targets);
		},
	};
	if (withDamageBonus) {
		skill.group = ["kgy_jingangshi_damage"];
	}
	return skill;
}

/** 锁定技，受到伤害时把伤害值压到 1 点（+可选：伤害来源失去 1 点体力） */
function kgyDamageToOneSkill(minNum, hurtSource) {
	return {
		equipSkill: true,
		audio: false,
		locked: true,
		forced: true,
		// damageBegin4 是伤害值最终定下来之前（白银狮子的 baiyin_skill 用的是同一个时机）
		trigger: { player: "damageBegin4" },
		filter(event, player) {
			return event.num >= minNum;
		},
		async content(event, trigger, player) {
			trigger.num = 1;
			if (hurtSource) {
				const source = trigger.source;
				if (source && source.isIn()) {
					await source.loseHp(1);
				}
			}
		},
	};
}

const shenbaoSkills = {
	// ── 蓬莱的弹枝（升级前）──────────────────────────────────────
	// 锁定技，你使用【杀】无次数限制。
	// 每回合限一次，你使用【杀】时，摸一张牌。
	kgy_danzhi_skill: kgyShaDrawSkill(1, false),

	// ── 蓬莱的玉枝（升级后）──────────────────────────────────────
	// 锁定技，你使用【杀】无距离次数限制。
	// 每回合限两次，你使用【杀】时，摸一张牌。
	kgy_yuzhi_skill: kgyShaDrawSkill(2, true),

	// ── 龙颈之玉（升级前）────────────────────────────────────────
	// 每回合限一次，你使用锦囊牌指定目标后，可以对其中一个目标造成 1 点伤害。
	//
	// 「其中一个」是靠 useCardToPlayered 的**逐目标触发**实现的：
	// 引擎对每个目标各触发一次，玩家在想要的那个目标上点「发动」即可；
	// usable: 1 保证最多只会真的打出一次，而点「取消」不计入次数
	// （usable 的计数写在技能真正发动时，见 content.js 的 trigger 收尾）。
	kgy_longyu_skill: {
		equipSkill: true,
		audio: false,
		usable: 1,
		trigger: { player: "useCardToPlayered" },
		filter(event, player) {
			if (event.target == player) {
				return false;
			}
			return get.type2(event.card) == "trick";
		},
		async content(event, trigger, player) {
			player.line(trigger.target, "fire");
			await trigger.target.damage(1, player);
		},
	},

	// ── 耀眼的龙玉（升级后）──────────────────────────────────────
	// 每回合限一次，你使用牌指定目标后，可以对所有目标造成 1 点伤害。
	kgy_yaolongyu_skill: {
		equipSkill: true,
		audio: false,
		usable: 1,
		trigger: { player: "useCardToPlayered" },
		filter(event, player) {
			return kgyOtherTargets(event.getParent("useCard"), player).length > 0;
		},
		async content(event, trigger, player) {
			const targets = kgyOtherTargets(trigger.getParent("useCard"), player);
			for (const target of targets) {
				player.line(target, "fire");
				await target.damage(1, player);
			}
		},
	},

	// ── 燕的子安贝（升级前）──────────────────────────────────────
	// 每回合限一次，你可以令一名角色获得 1 点护甲。
	kgy_zianbei_skill: {
		equipSkill: true,
		audio: false,
		enable: "phaseUse",
		usable: 1,
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget({
					prompt: "燕的子安贝：令一名角色获得1点护甲",
					selectTarget: 1,
					forced: true,
					ai(target) {
						return get.attitude(player, target) * (target.hujia < 2 ? 1 : 0.5);
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			const target = result.targets[0];
			player.line(target, "green");
			await target.changeHujia(1);
		},
		ai: { order: 8, result: { player: 1 } },
	},

	// ── 无限的生命之泉（升级后）──────────────────────────────────
	// 每回合限一次，你可以令至多两名角色回复 1 点体力。
	kgy_shengmingquan_skill: {
		equipSkill: true,
		audio: false,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			return game.hasPlayer(current => current.isDamaged());
		},
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget({
					prompt: "无限的生命之泉：令至多两名角色回复1点体力",
					selectTarget: [1, 2],
					filterTarget(card, player, target) {
						return target.isDamaged();
					},
					ai(target) {
						return get.attitude(player, target) * 2;
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			for (const target of result.targets) {
				player.line(target, "green");
				await target.recover(1);
			}
		},
		ai: { order: 8, result: { player: 2 } },
	},

	// ── 佛御石之钵（升级前）──────────────────────────────────────
	// 锁定技，你使用的【杀】不可被响应。
	kgy_foyushi_skill: kgyShaDirectHitSkill(false),

	// ── 佛体的金刚石（升级后）────────────────────────────────────
	// 锁定技，你使用的【杀】不可被响应，且此【杀】造成的伤害 +1。
	kgy_jingangshi_skill: kgyShaDirectHitSkill(true),

	// 金刚石的伤害 +1（charlotte，不进技能栏；靠主技能的 group 生效）
	kgy_jingangshi_damage: {
		equipSkill: true,
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "kgy_jingangshi_skill",
		// damageBegin1：伤害结算第一步，此时改 trigger.num 还来得及
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			if (event.num <= 0 || event.unreal) {
				return false;
			}
			// event.card 就是造成这次伤害的那张牌；是【杀】才 +1
			return !!event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},

	// ── 火鼠的皮衣（升级前）──────────────────────────────────────
	// 锁定技，当你受到大于 1 点的伤害时，你将伤害值改为 1 点。
	// （「失去装备区里的它后回复 1 点体力」由【难题】统一监听，见 skill.js）
	kgy_piyi_skill: kgyDamageToOneSkill(2, false),

	// ── 火蜥蜴之盾（升级后）──────────────────────────────────────
	// 锁定技，当你受到大于等于 1 点的伤害时，你将伤害值改为 1 点，
	// 伤害来源失去 1 点体力。
	kgy_huoxiyi_skill: kgyDamageToOneSkill(1, true),
};

/** 一次用牌里除自己以外的目标 */
function kgyOtherTargets(useCardEvent, player) {
	const targets = useCardEvent && useCardEvent.targets ? useCardEvent.targets : [];
	return targets.filter(target => target != player);
}

export { cards, shenbaoSkills, kgyIsShenbao, KGY_SHENBAO, KGY_SHENBAO_BASE, KGY_SHENBAO_SKILLS, KGY_SHENBAO_UPGRADE };
