// lib 必须显式导入：技能里会用到 lib.filter.notMe / lib.skill.xxx_backup，
// 不要依赖 window.lib 这个隐式全局（联机模式、打包环境下不保证存在）
import { game, get, lib, ui, _status } from "noname";
// 十张「神宝」衍生卡（连装备技能一起）定义在 character/card.js，
// 这里只取辉夜的武将技能要用到的那几个常量与判定函数
import { kgyIsShenbao, KGY_SHENBAO_BASE, KGY_SHENBAO_SKILLS, KGY_SHENBAO_UPGRADE } from "./card.js";

/**
 * 判断某个技能名是否出自【黎明】的视为技。
 *
 * 用 chooseButton + backup 实现的视为技，真正使用牌时技能名会变成引擎动态生成的
 * "<技能名>_backup"（见 content.js 里 chooseButton 的收尾处理），
 * 引擎会给它加上 sourceSkill 指回主技能，所以这里要用 get.sourceSkillFor 解析。
 */
function isLimingShaSkill(skill) {
	if (!skill) {
		return false;
	}
	return skill == "wsde_liming_sha" || get.sourceSkillFor(skill) == "wsde_liming_sha";
}

// ══════════════════════════════════════════════════════════════════
// 夕 —— 「魉」这套召唤单位的公共逻辑
//
// 「魉」不是标记、也不是状态，而是**真真正正插进座位表的一个玩家**：
//   game.addPlayerOL(player, "dx_liang", null, isNext, { source: player })
// 它会 createPlayer、init 武将、push 进 game.players、arrangePlayers() 重排座位，
// 并 broadcast 给所有客户端。所以「魉」有自己的回合、自己的体力和手牌。
//
// 夕的三个技能全都围绕它转：
//   墨魎 造出它    丹青 用它做支点    写意 在它碎掉时收尾
// ══════════════════════════════════════════════════════════════════

/** 「魉」的武将牌 id（character.js 里的 dx_liang，2 体力、无技能） */
const DX_LIANG = "dx_liang";

/**
 * 找出某人的「魉」。没有就返回 null。
 *
 * 用 `_trueMe` 反查而不是自己记 storage：引擎的 isUnderControl() 就是靠
 * `_trueMe` 判定归属的，用同一个字段查才不会两边不一致。再叠一层武将牌
 * id 的判断，免得把别的东西（比如将来别的召唤物）误认成魉。
 */
function dxLiangOf(owner) {
	return game.filterPlayer(current => current != owner && current._trueMe == owner && current.name == DX_LIANG)[0] || null;
}

/**
 * 这张牌是不是「伤害类锦囊」。
 *
 * 两个条件缺一不可：
 *   · get.type2(card) == "trick" —— 必须先是一张锦囊（普通 + 延时都算）
 *   · get.tag(card, "damage")    —— 引擎里判定「这张牌会造成伤害」的标准方式
 * get.tag 对【杀】也返回 true，所以只靠它会把【杀】也算进来，必须配 type2。
 */
function dxIsDamagingTrick(card) {
	return get.type2(card) == "trick" && get.tag(card, "damage");
}

/** 黑色锦囊牌（丹青②「创物」的素材，也是入画判定用的颜色标准） */
function dxIsBlackTrickCard(card) {
	return get.type2(card) == "trick" && get.color(card) == "black";
}

// ══════════════════════════════════════════════════════════════════
// 蓬莱山辉夜 —— 「神宝」体系的公共逻辑
//
// 十张神宝卡**本身**定义在 character/card.js（连装备技能一起写在那儿），
// 这里只放武将技能用得着的部分：
//   · 谁是「神宝」的主人（也就是拥有【难题】的人）
//   · 某人区域内有哪些神宝
//   · 一次 lose 事件里谁丢掉了哪些神宝
//   · 把一张神宝升级成它的进阶形态
//   · 五个觉醒技的公共骨架
// ══════════════════════════════════════════════════════════════════

/** 承载「其他角色不能使用／打出／弃置神宝」等规则的**全局技能**名 */
const KGY_RULE = "kgy_nanti_rule";

/** 场上拥有【难题】的人（也就是辉夜）。没有就返回 null。 */
function kgyOwner() {
	return game.filterPlayer(current => current.hasSkill("kgy_nanti"))[0] || null;
}

/** 这个人自己就是「神宝」体系的主人，所以不受【难题】的禁令约束 */
function kgyIsOwner(player) {
	return !!player && player.hasSkill("kgy_nanti");
}

/**
 * 「神宝体系」现在还在不在场上。
 *
 * 主人一死，【难题】那几条**禁令**就该失效 —— 否则散在别人手里的神宝会永久卡住：
 * 不能用、不能弃，而「还回去」那条又找不到主人（`kgyOwner` 只查存活角色）。
 * 退化回普通宝物牌是唯一不会把牌卡死的处理。
 */
function kgyActive() {
	return !!kgyOwner();
}

/** 某人区域内的全部「神宝」 */
function kgyShenbaoOf(player, position = "hej") {
	return player.getCards(position, kgyIsShenbao);
}

/**
 * 全场**任何一个角落**里的「神宝」。
 *
 * 【难题】那条「无论其在何处，都将其移入手牌」要的就是这个 ——
 * 一张神宝可能正躺在牌堆里（开局洗进去的五张还没被人摸到）、弃牌堆里、
 * 结算中的处理区里，或者被谁攥在手上 / 装备着。所以要挨个容器翻一遍：
 *
 *   ui.cardPile    牌堆
 *   ui.discardPile 弃牌堆
 *   ui.ordering    处理区（牌正在结算时待的地方）
 *   ui.special     游戏外（被移出游戏的牌）
 *   各角色的 hej   手牌 / 装备区 / 判定区
 *
 * 用 Set 去重：同一张牌在遍历过程中可能被两个容器同时引用（比如正在移动中途）。
 */
function kgyAllShenbao() {
	const out = [];
	const seen = new Set();
	const add = card => {
		if (card && !seen.has(card) && get.itemtype(card) == "card" && kgyIsShenbao(card)) {
			seen.add(card);
			out.push(card);
		}
	};
	for (const area of [ui.cardPile, ui.discardPile, ui.ordering, ui.special]) {
		if (area && area.childNodes) {
			for (const card of area.childNodes) {
				add(card);
			}
		}
	}
	for (const current of game.players.concat(game.dead)) {
		for (const card of current.getCards("hej")) {
			add(card);
		}
	}
	return out;
}

/**
 * event.getl(player) 返回的对象里，**哪几个键是牌数组**。
 *
 * 引擎的 next.getl（见 player.js）返回的永远是这样一套：
 *     { player, hs, es, js, ss, xs, cards, cards2, gaintag_map, vcard_map }
 * 其中只有下面这七个是数组。
 *
 * ★ 千万别图省事写成 `for (const key of Object.keys(evt))` 挨个 for...of ——
 *   `player` 是个 Player 对象、`gaintag_map` 是个普通对象，两者都**不可迭代**，
 *   会直接抛 `(list || []) is not iterable`。
 *   这个坑实机踩过一次：辉夜装备神宝时（useCard → lose → arrangeTrigger）
 *   整条技能链炸掉，错误框定位在 collect() 的 for 循环上。
 */
const KGY_LOSE_CARD_KEYS = ["hs", "es", "js", "ss", "xs", "cards", "cards2"];

/**
 * 这次 lose 是不是「装备被同类型的另一件顶掉」。
 *
 * content.js 的 equip 流程里，顶掉旧装备那一次长这样：
 *     const loseEvent = player.lose(result.cards, "visible").set("type", "equip").set("getlx", false);
 *     loseEvent.swapEquip = true;
 * 所以 `swapEquip`（退一步：`type == "equip"` 的 lose）就是它的指纹。
 *
 * 需要这个指纹，是因为这一路的 lose 带 `getlx: false` —— 它不进 lose 历史，
 * `getl()` 拿不到，也就分不出「牌原来在哪个区域」；
 * 而火鼠的皮衣 / 火蜥蜴之盾 的「失去后回血」只认装备区。
 */
function kgyIsEquipSwap(event) {
	for (const evt of [event, event && typeof event.getParent == "function" ? event.getParent() : null]) {
		if (!evt) {
			continue;
		}
		if (evt.swapEquip === true) {
			return true;
		}
		if (evt.name == "lose" && evt.type == "equip") {
			return true;
		}
	}
	return false;
}

/**
 * 一次 lose 事件里，某个玩家丢掉了哪些「神宝」。
 *
 * 丢掉的牌可能来自手牌 / 装备区 / 判定区，所以把 getl 结果里那几个**牌数组**
 * 都扫一遍再按物理牌去重。
 *
 * ★ 但**不能只靠 getl()**：它会漏掉 `getlx === false` 的那一类事件，
 *   而「神宝被另一件宝物顶掉」走的正是那条路 ——
 *   content.js 的 equip 流程里，顶掉旧装备用的是
 *       player.lose(cards, "visible").set("type", "equip").set("getlx", false)
 *   `getlx: false` 的事件不进 lose 历史，`getl()` 于是返回一个空 map。
 *   实机上的表现就是「神宝被顶掉后没有回到手里」。
 *   所以这里备了一条退路：getl 什么都没捞到时，直接看 `event.cards`
 *   —— 它是这次 lose 事件的原始牌数组，而且属于 `event.player` 本人。
 *
 * @returns {{ card: Card, name: string }[]} all 与 equip
 *   all   —— 丢掉的**全部**神宝（手牌里的也算）
 *   equip —— 其中来自**装备区**的那些
 *            （火鼠的皮衣 / 火蜥蜴之盾 的「失去后回血」只认这一部分）
 */
function kgyLostShenbao(event, player) {
	const evt = event && typeof event.getl == "function" ? event.getl(player) : null;
	// vcard_map 把「物理牌」映射到「它当时被当成的那张牌」——转化牌要靠它才认得出来。
	// 装备牌一般不会被转化，但用同一套写法更稳。
	const nameOf = card => {
		const vcard = evt && evt.vcard_map && typeof evt.vcard_map.get == "function" ? evt.vcard_map.get(card) : null;
		return (vcard || card).name;
	};
	const push = (list, target) => {
		// ★ 必须挡住非数组：getl() 返回的对象里还有 player / gaintag_map 两个
		//   不可迭代的字段，误把它们当数组 for...of 会抛
		//   `(list || []) is not iterable`（这个坑也实机踩过一次）
		if (!Array.isArray(list)) {
			return;
		}
		for (const card of list) {
			if (!card || get.itemtype(card) != "card") {
				continue;
			}
			const name = nameOf(card);
			if (kgyIsShenbao(name) && !target.some(item => item.card == card)) {
				target.push({ card, name });
			}
		}
	};
	const all = [];
	const equip = [];
	if (evt) {
		for (const key of KGY_LOSE_CARD_KEYS) {
			push(evt[key], all);
		}
		push(evt.es, equip);
	}
	// getl() 什么都没捞到时的退路（getlx:false 事件）
	if (!all.length && event && event.player == player && Array.isArray(event.cards)) {
		push(event.cards, all);
		// 这条路上分不出区域，只能靠「装备被顶掉」的指纹来认
		if (kgyIsEquipSwap(event)) {
			push(event.cards, equip);
		}
	}
	return { all, equip };
}

/**
 * 在 kgyLostShenbao 的基础上，剔掉「正在被使用的那些牌」。
 *
 * 装备一张牌时引擎会先让它离开手牌（useCard → lose），紧接着再落进装备区
 * —— 同一张牌换了个区域，并没有离开辉夜，不该被拉回手牌。
 *
 * ★ 只剔「正在被使用的牌本身」，不能因为「这次 lose 的父事件是 useCard」就整次跳过：
 *   使用一件新宝物把**旧神宝顶掉**时，旧神宝也挂在同一次 useCard 结算下面，
 *   而它是真的要拉回来的。
 */
function kgyLostToRecover(event, player) {
	const lost = kgyLostShenbao(event, player);
	if (!lost.all.length) {
		return lost;
	}
	const useCard = event && typeof event.getParent == "function" ? event.getParent("useCard") : null;
	const used = useCard && Array.isArray(useCard.cards) ? useCard.cards : [];
	if (!used.length) {
		return lost;
	}
	return {
		all: lost.all.filter(item => !used.includes(item.card)),
		equip: lost.equip.filter(item => !used.includes(item.card)),
	};
}

/**
 * 辉夜本回合还没对这名角色用过【须臾】吗。
 *
 * 【须臾】的限制是「**每回合每角色限一次**」，不是「每回合只能发动一次」——
 * 辉夜一个出牌阶段里可以反复发动（每次弃 4 张牌），但对同一个角色只算一次。
 * 名单存在 `player.storage.kgy_xuyu_targets` 里，
 * 由 kgy_xuyu_reset 在辉夜自己的回合结束时清空。
 */
function kgyXuyuAvailable(player, target) {
	const list = player.storage.kgy_xuyu_targets;
	return !Array.isArray(list) || !list.includes(target);
}

/** 记下「本回合已经对谁用过须臾」 */
function kgyXuyuMark(player, target) {
	const list = player.storage.kgy_xuyu_targets;
	if (!Array.isArray(list)) {
		player.storage.kgy_xuyu_targets = [target];
		return;
	}
	if (!list.includes(target)) {
		list.push(target);
	}
}

/**
 * 让辉夜挑一件还没升级的神宝升级。
 *
 * ★ 候选取自**全域**（`kgyAllShenbao`），不是「辉夜自己身上的那些」——
 *   与【难题】那条「无论其在何处」同一个思路：
 *   一张神宝可能还在牌堆里（开局洗进去的五张没人摸到）、在弃牌堆、
 *   也可能被谁攥在手上或装备着，辉夜照样能把它点亮。
 *   升级动的是**这张牌本身**（`card.init` 换卡名），它在哪儿不受影响。
 *
 * ★ 无论有几件可选都**弹出来让玩家自己挑**。
 *   早先的版本是「只有一件就直接升」，本意是省一次点击，
 *   但觉醒链一路走下来，场上往往同时躺着好几件神宝，
 *   玩家需要自己决定先把哪一件点亮 —— 替玩家做这个决定是错的。
 *
 * 用 `forced` 是因为觉醒技里的「升级一件」本身是强制的：
 * 玩家选的是**哪一件**，不是「要不要升」。
 */
async function kgyUpgradeShenbao(player) {
	const cards = kgyAllShenbao().filter(card => !!KGY_SHENBAO_UPGRADE[card.name]);
	if (!cards.length) {
		return;
	}
	const result = await player
		.chooseCardButton({
			cards,
			prompt: "选择一张「神宝」升级",
			forced: true,
			select: 1,
		})
		.forResult();
	if (!result.bool || !Array.isArray(result.links) || !result.links.length) {
		return;
	}
	const card = result.links[0];
	const oldName = card.name;
	const newName = KGY_SHENBAO_UPGRADE[oldName];
	// 升级的是**同一件**宝物，所以花色点数原样保留，只换卡名。
	// card.init 是引擎里改卡名的标准做法（mobile/skill.js 的 rewrite_ 系列也是这么写的）。
	card.init([card.suit, card.number, newName, card.nature]);
	game.log(player, "将", `【${get.translation(oldName)}】`, "升级为", `【${get.translation(newName)}】`);
}

/**
 * 生成一个「神宝」觉醒技。
 *
 * 初月 / 待宵 / 朝靄 / 拂晓 / 永夜归反 -破晓明星- 是同一条链上的五步，
 * 差别只有三个数：需要几件神宝、觉醒后拿到什么、要不要涨体力上限。
 *
 * @param {object} config
 * @param {number} config.need   至少要有几件神宝才能觉醒
 * @param {string[]} config.gain 觉醒后获得哪些技能
 * @param {boolean} [config.maxHp] 是否额外 +1 点体力上限
 * @param {string} [config.color] skillAnimation 的配色
 */
function kgyAwakenSkill({ need, gain, maxHp, color }) {
	return {
		audio: false,
		// 这三个字段让引擎把它标成觉醒技，并播一段觉醒动画
		juexingji: true,
		forced: true,
		skillAnimation: true,
		animationColor: color || "orange",
		// 「回合开始时」在引擎里最常用的时机是准备阶段开始（phaseZhunbeiBegin）
		trigger: { player: "phaseZhunbeiBegin" },
		filter(event, player) {
			return player.countCards("hej", kgyIsShenbao) >= need;
		},
		async content(event, trigger, player) {
			// 发动过就不再发动，由引擎按 awakenedSkills 记录，不用自己判
			player.awakenSkill(event.name);
			await player.recover(1);
			if (maxHp) {
				await player.gainMaxHp();
			}
			await kgyUpgradeShenbao(player);
			if (gain && gain.length) {
				player.addSkill(gain);
			}
			game.log(player, "觉醒了", `【${get.translation(event.name)}】`);
		},
	};
}

/**
 * 【过载】当前该「视为拥有」哪几个技能，用一个短字符串当指纹。
 *
 * 两档是**叠加**的 —— 描述里「低于3时」和「低于2时」是两条独立条件，
 * 所以体力低于 2 时【沸腾】和【爆裂】同时在手（摸牌阶段的摸牌数因此会 +2）。
 *
 * 指纹只用于「和上一次比一比」（见 huang_guozai 的 filter：
 * 指纹没变就不发动，免得每掉一次血都跳一次技能提示），
 * `undefined`（从没发动过）用 `|| ""` 兜成空串，正好等价于「一个都没有」。
 */
function huangGuozaiKey(player) {
	return (player.hp < 3 ? "f" : "") + (player.hp < 2 ? "b" : "");
}

// ══════════════════════════════════════════════════════════════════
// 琪露诺 · 湖上的冰精 —— 【智慧】的「失去牌」记账
// ══════════════════════════════════════════════════════════════════

/** 某名角色本次「失去牌」的张数，键是 `playerid`（联机时 storage 要能序列化） */
function qlnoCountKey(target) {
	return String(target.playerid);
}

/**
 * 数出「这一次 lose 事件里，该角色真正失去了几张牌」。
 *
 * 与辉夜【难题】的 kgyLostShenbao 同一套取数法（getl 为主、event.cards 兜底），
 * 区别只在这里只关心**张数**，不关心是什么牌。
 *
 * 两个必须这么写的理由：
 *   · `getl()` 会漏掉 `getlx === false` 的事件（装备被同类顶掉走的就是那条路），
 *     所以什么都没捞到时退回 `event.cards`；
 *   · `getl()` 返回的固定那套字段里 `player` / `gaintag_map` **不可迭代**，
 *     只扫 `cards` 一个数组就够（它已经把 hs/es/js/ss/xs 全部并进去了），
 *     避开了 `(list || []) is not iterable` 那个坑；
 *   · 只认 `get.itemtype(card) == "card"` —— 虚拟牌不算「失去一张牌」，
 *     一次 3 张牌的视为技在 lose 事件里也只有 3 张实体牌。
 *
 * ★ 还必须剔掉「真的没离开这个人」的那些牌，最典型的反例是**装备牌**：
 *   `useCard` 会先让这张牌离开手牌（lose），紧接着才把它落进装备区 ——
 *   牌始终在这个人身上，不是「失去1张牌」。
 *   引擎对「牌现在归谁」的唯一判据就是 `get.owner(card)`（直接看牌当前挂在
 *   谁的 node 下面，见 get/index.js），所以用它来剔：
 *     · 还在自己区域里 → 本次 lose 只是「换了个区域」，不算；
 *     · 什么都不返回（牌正处在处理区 / 弃牌堆 / 别人手里）→ 真的失去了，算。
 *   这一条同时也覆盖了「判定区的牌被移去判定区」这类内部移动。
 *
 * 注意 lose 事件本身**不代表牌离开了这个人**，所以这道过滤不能省。
 */
function qlnoGenuineLost(event, target) {
	if (!event) {
		return 0;
	}
	const evt = typeof event.getl == "function" ? event.getl(target) : null;
	let cards = evt && Array.isArray(evt.cards) ? evt.cards.slice(0) : [];
	if (!cards.length && event.player == target && Array.isArray(event.cards)) {
		cards = event.cards.slice(0);
	}
	const seen = [];
	for (const card of cards) {
		if (card && get.itemtype(card) == "card" && !seen.includes(card) && get.owner(card) != target) {
			seen.push(card);
		}
	}
	return seen.length;
}

/**
 * 这张牌是不是【冰精】用三张牌变出来的那张冰【杀】。
 *
 * 主技能（`viewAs`）变出来的是一张**虚拟牌**，它没有 cardid、也不在任何区域，
 * 但 `viewAs` 里挂在牌上的 `storage` 会一路跟到 `useCard` 事件上
 * （VCard 只是个普通对象，`storage` 是它自己的字段，引擎不会清它）。
 *
 * 所以判据是「card.storage.qlno_bingjing」。
 * 这条判据只可能在「琪露诺自己正在用这张牌」的时候被问到 ——
 * `game.checkMod(..., <技能拥有者>)` 里的技能拥有者永远是那个正在用牌的人，
 * 而带着这个 storage 的虚拟牌只可能是她本人生成的。
 */
function qlnoIsBingjingSha(card) {
	return !!(card && card.storage && card.storage.qlno_bingjing);
}

// ══════════════════════════════════════════════════════════════════
// 结城理 · 月行水上 —— 三张「面具」武将牌的公共逻辑
//
// 一个武将、三张武将牌，显示名都叫「结城理」，描述上都只有「面具」一个技能。
// 转换链（面具①②③ 即武将牌 1/2/3）：
//     面具① --死亡--> 面具② --死亡--> 面具③
//     面具② / 面具③ --自己回合开始--> 面具①
// 三张牌体力上限都是 1，换牌即回满。
// ══════════════════════════════════════════════════════════════════

/** 结城理的三张面具牌，顺序即转换顺序 */
const JYCL_MASKS = ["jycl_makoto1", "jycl_makoto2", "jycl_makoto3"];

/** 面具牌 -> 它对应的主技能名（语音文件的查找按技能名走，见 get/audio.js） */
const JYCL_MAIN_SKILL = {
	jycl_makoto1: "jycl_mianju_a",
	jycl_makoto2: "jycl_mianju_b",
	jycl_makoto3: "jycl_mianju_c",
};

/**
 * 专用音效的音量系数。1 = 与游戏内「选项 → 音效音量」保持一致。
 *
 * 游戏里那个设置是 0~8 的整数（lib.config.volumn_audio，初始 8），
 * 引擎播放时统一算成 volume = volumn_audio / 8（即 0~1）。这里再乘一个系数，
 * 就能在**不动全局音量**的前提下单独压这几个音效：
 *   0 = 静音，0.5 = 减半，1 = 不变，想更响可以到 1 以上（最终会被夹到 1）。
 * 调全局就进游戏设置改「音效音量」，那个对所有音效（含技能台词）一起生效。
 *
 * 系数本身在「扩展 → 方舟」的设置页里按角色分组，键名与扩展 config 一一对应。
 */
const SFX_VOLUME_KEY = {
	"切换为面具": "vol_jycl_swap",
	"转换技音效": "vol_cx_convert",
	"攻击音效": "vol_cx_attack",
	// 浮泡的「生成 / 消失」来自遥的原始素材（p_skill_wtrlimeboost / wtrlimedead），
	// 比台词长（1.49s / 1.22s），默认压到 0.7 免得吵
	"浮泡生成": "vol_yao_fupao_on",
	"浮泡消失": "vol_yao_fupao_off",
};
const SFX_VOLUME_DEFAULT = {
	"切换为面具": 1,
	"转换技音效": 1,
	"攻击音效": 1,
	"浮泡生成": 0.7,
	"浮泡消失": 0.7,
};

/** 某条专用音效当前的音量系数（读扩展设置） */
function sfxVolume(name) {
	const key = SFX_VOLUME_KEY[name];
	if (!key) {
		return 1;
	}
	return Math.max(0, Math.min(2, arknightsCfgNum(key, SFX_VOLUME_DEFAULT[name] ?? 1)));
}

/**
 * 播一条专用音效（素材放在 skill/ 下，文件名即 name）。
 *
 * game.playAudio 会把音量写死成 lib.config.volumn_audio / 8，但它把创建好的
 * <audio> 元素返回了，所以拿回来盖一次 volume 就行 —— volume 是同步属性，
 * 不受它内部「异步设置 src」的影响。
 * path 里带扩展名就直接用、不带才补 .mp3（见 game/index.js 的 playAudio）。
 * ext：素材后缀。浮泡那两条是原始 WAV（没转 mp3），所以留了个口子。
 */
function playSfx(name, ext = "mp3") {
	const audio = game.playAudio(`ext:方舟/skill/${name}.${ext}`);
	if (audio) {
		const scale = sfxVolume(name);
		audio.volume = Math.max(0, Math.min(1, (lib.config.volumn_audio / 8) * scale));
	}
	return audio;
}

// ══════════════════════════════════════════════════════════════════
// 浮泡特效（预研）—— 遥的「浮泡」标记的视觉表现
//
// 纯视觉，不参与任何结算：往角色卡片上叠一个球壳，跟着「浮泡」标记的生灭走。
//
// 形状/颜色/时间轴全部对着《遥二技能_复现规格.txt》来（素材在同名美术包）：
//   ① sphere bg   haruka_45  灰白 @50%      startSize 3.1  → 半径只有核心的 53%
//   ② sphere core haruka_44  粉色菲涅尔壳   startSize 5.8  ← 主要看得见的那层
//   ③ zt_yu 金鱼   haruka_iteration#6_03 右上角裁切  ← 球壳里上下两条金鱼对着转圈
//   ④ bubble 粒子  haruka_46  bubble_01 贴图      ← 壳内壁飘的一圈小白泡
// ①② 的网格都是「上下不封口的球面」，所以球壳用遮罩把上下球冠切掉：
//   general_sphere_01 → 极角 0°~130°（缺下球冠）
// 说明：规格书把皮肤版的 sphere flow（flow_337 贴图）也算进浮泡，但那条是**破碎瞬间**的
// 表现，常态浮泡里能看见的是金鱼 + 小气泡，所以这里不挂 flow_337。
//
// 为什么不用官方 API：无名杀没有「给角色挂一个持续特效」的现成接口，
// 标记本身只是 storage 里的一个数字 + 一小块文字标记。
// 但 addMark / removeMark 内部都会 createEvent 出一个同名事件并带上
// event.markName（见 library/element/player.js），所以监听这两个事件就能
// 让特效自动跟着标记走 —— 完全不用改赋予 / 移去浮泡的那两处代码。
// ══════════════════════════════════════════════════════════════════
const YAO_FX_CLASS = "yao-fupao-fx";
const YAO_FX_OUT_CLASS = "yao-fupao-out";
const YAO_FX_STYLE_ID = "yao-fupao-fx-style";
// 球壳本体。素材是作者画好的一张**香皂泡**（虹彩边缘 + 全透明中心），
// 源文件 E:\Deepseek\素材\遥\浮泡.png，242×273，球体直径 216px、圆心就在图中心
// （实测水平中线亮边在 x 12 / 228，垂直中线在 y 30 / 246）。
// 拷进来时抹掉了左上角 y<18 的一点孤立杂色。
const YAO_SHELL_URL = `${lib.assetURL}extension/方舟/image/yao_fupao_shell.png`;
// 球壳里游动的金鱼。素材是作者用 PS **沿球壳边缘拉伸变形**做好的一张图
// （源文件 E:\Deepseek\素材\遥\游鱼.png），里面上、下两条鱼已经分别在圆弧的两侧，
// 所以这里不需要再切片弯弧：整张图绕球心转就行，两条鱼天然就是"一上一下对角转"。
//
// 实测这张图：277×345，鱼环的圆心正好在图中心（偏差 0.5px），alpha 加权的平均半径 144.4px。
// 要让它等于 r% 球壳，图宽应设为 r% × 277 / 144.4 = r% × 1.918 —— 就是下面这个系数。
const YAO_FISH_URL = `${lib.assetURL}extension/方舟/image/yao_fupao_fish.png`;
// 球壳内壁那一圈小白泡（assets 原图 tex\bubble_01.png，512×512，3×3 共 9 帧、每帧约 170×170）
const YAO_BUBBLE_URL = `${lib.assetURL}extension/方舟/image/yao_fupao_bubble.png`;
// 右上角那道弧形白色高光（assets 原图 tex\haruka_07.png，128×128，三道渐细的白弧）
const YAO_GLINT_URL = `${lib.assetURL}extension/方舟/image/yao_fupao_glint.png`;

// ══════════════════════════════════════════════════════════════════
// 可调参数 —— 全部在「扩展 → 方舟」的设置页里改，按角色分组（见 extension.js 的 config）。
// 这一段**刻意写成自包含的**：除了 lib 不引用本文件里的任何东西。
// 这样 tools/make-preview.mjs 能把整段抠出来在浏览器里单独跑，不开游戏就能看效果。
// ══════════════════════════════════════════════════════════════════
const ARKNIGHTS = "方舟";

/** 读扩展设置。键名就是 extension.js config 里的键，存储键 = extension_方舟_<key> */
function arknightsCfg(key, def) {
	const value = lib?.config?.[`extension_${ARKNIGHTS}_${key}`];
	return value === undefined || value === null || value === "" ? def : value;
}
/** 同上，但强制转成数字；非法值回落到默认 */
function arknightsCfgNum(key, def) {
	const num = parseFloat(arknightsCfg(key, def));
	return isNaN(num) ? def : num;
}

// 默认值。所有"百分之多少"都是以**球壳**为参照的（球壳直径 = 卡片宽度 × sizePct%）
const YAO_FX_DEFAULTS = {
	sizePct: 168, // 球壳直径 = 卡片宽度的百分之多少
	shell: 1, // 球壳浓度倍率
	fishScale: 1.2, // 金鱼大小倍率（1.2 是实机对比下来最合适的，见 extension.js 的档位）
	fishOpacity: 0.95, // 金鱼不透明度
	fishSpeed: 1, // 金鱼转速倍率
	bubbleScale: 1, // 小气泡大小倍率
	bubbleSpeed: 1, // 小气泡上升速度倍率
	bubbleRise: 9, // 小气泡一轮往上飘多远（球壳高度的百分之多少）
	glint: true, // 右上角高光
	glintScale: 1, // 高光大小倍率
};

// 金鱼：素材已经是弯好的（见上），这里只描述"这一圈鱼"怎么转。
// r 鱼身的贴合半径（球壳高度的百分比，球壳半径 = 50%；鱼环最外缘约是均值的 1.2 倍，
//   所以 r 取 36% 时最外缘 ≈ 43%，正好留在球壳里），
// scale 把图里的鱼环放大到 r% 上的系数（277 / 144.4，见上），
// dur 绕一圈秒数。大小 / 不透明度 / 转速都在扩展设置里调。
const YAO_FISH = { r: 36, scale: 1.918, dur: 9 };
// 六颗小气泡：a 圆周方位角(度)，r 半径（34%~46% 正好贴着内壁），s 大小，
// frame 3×3 序列帧里的第几帧，dur 飘一轮的秒数
const YAO_BUBBLE = [
	{ a: -26, r: 41, s: 6.5, frame: 0, dur: 4.4, delay: 0, op: 0.9 },
	{ a: 34, r: 45, s: 5, frame: 1, dur: 5.6, delay: -1.4, op: 0.8 },
	{ a: 108, r: 38, s: 6, frame: 3, dur: 4.8, delay: -3, op: 0.75 },
	{ a: 162, r: 44, s: 4.5, frame: 5, dur: 6.2, delay: -0.8, op: 0.8 },
	{ a: 214, r: 37, s: 5.5, frame: 7, dur: 4.2, delay: -2.2, op: 0.85 },
	{ a: 296, r: 43, s: 6, frame: 8, dur: 5.2, delay: -3.8, op: 0.7 },
];

/** 把设置里的倍率套到默认值上，得到这一次挂特效要用的实际数值 */
function yaoFxOptions() {
	const d = YAO_FX_DEFAULTS;
	return {
		sizePct: arknightsCfgNum("fx_size", d.sizePct),
		shell: arknightsCfgNum("fx_shell", d.shell),
		bubbleRise: arknightsCfgNum("fx_bubble_rise", d.bubbleRise),
		fishScale: arknightsCfgNum("fx_fish_scale", d.fishScale),
		fishOpacity: arknightsCfgNum("fx_fish_opacity", d.fishOpacity),
		fishSpeed: arknightsCfgNum("fx_fish_speed", d.fishSpeed),
		bubbleScale: arknightsCfgNum("fx_bubble_scale", d.bubbleScale),
		bubbleSpeed: arknightsCfgNum("fx_bubble_speed", d.bubbleSpeed),
		glint: arknightsCfg("fx_glint", d.glint) !== false,
		glintScale: arknightsCfgNum("fx_glint_scale", d.glintScale),
	};
}


/**
 * 鱼群的 innerHTML —— 就一个元素。
 * 宽度 = 贴合半径 × 1.918（把图里的鱼环放大到 --radius 上），高度由图自带的宽高比撑开。
 * fishScale 同时放大鱼和鱼环：想让鱼更靠外、更大，直接调这一个数。
 */
function yaoFishHtml(opt) {
	const f = YAO_FISH;
	const width = (f.r * f.scale * opt.fishScale).toFixed(2);
	return (
		`<i class="yao-fupao-fish" style="--w:${width}%;` +
		`--dur:${(f.dur / opt.fishSpeed).toFixed(2)}s;--op:${opt.fishOpacity}"></i>`
	);
}

/** 右上角高光的 innerHTML（关掉设置里的开关就整层不加） */
function yaoGlintHtml(opt) {
	if (!opt.glint) {
		return "";
	}
	return `<i class="yao-fupao-glint" style="--size:${(40 * opt.glintScale).toFixed(2)}%"></i>`;
}

/** 小气泡的 innerHTML */
function yaoBubbleHtml(opt) {
	return YAO_BUBBLE.map(
		b =>
			`<i class="yao-fupao-bubble" style="--a:${b.a}deg;--r:${b.r}%;--dur:${(b.dur / opt.bubbleSpeed).toFixed(2)}s;` +
			`--delay:${b.delay}s;--op:${b.op}">` +
			`<u style="--s:${(b.s * opt.bubbleScale).toFixed(2)}%"><b style="background-position:${
				(b.frame % 3) * 50
			}% ${Math.floor(b.frame / 3) * 50}%"></b></u></i>`
	).join("");
}
// ══════════════════════════════════════════════════════════════════

// 浮光一次可以给**两名**角色挂浮泡，addMark 是连着调的，
// 不拦一下会两条「生成」音几乎同时响、叠成一声怪音。同名声效 300ms 内只播一次。
const yaoSfxAt = {};
function yaoPlayFupaoSfx(name) {
	// 「浮泡生成 / 消失」可以在扩展设置里单独关掉
	if (arknightsCfg("fx_fupao_sfx", true) === false) {
		return;
	}
	const now = Date.now();
	if (now - (yaoSfxAt[name] || 0) < 300) {
		return;
	}
	yaoSfxAt[name] = now;
	playSfx(name, "wav");
}

/**
 * 注入特效样式（只做一次）。
 *
 * 三层球壳 + 金鱼 + 小气泡：
 *   .yao-fupao-core   ② sphere core —— 粉色菲涅尔壳，主要观感来源
 *   .yao-fupao-fish   ③ zt_yu 金鱼  —— 球壳里上下两条金鱼对着转圈（haruka_01 贴图）
 *   .yao-fupao-bubble ④ bubble 粒子 —— 壳内壁一圈小白泡（bubble_01 贴图）
 * 规格里的 ① sphere bg（haruka_45，灰 @50%）没有做：它只是一层极淡的灰内胆，
 * 在 Unity 里靠叠加混合几乎看不出来，搬到 CSS 就变成卡中间一坨明显的深灰球，
 * 反而把"中间透明"这个最关键的特征盖掉了。
 *
 * ② 用 radial-gradient 而不是贴图：haruka_44 本来就没有 _MainTex，
 *   规格 4.1 给的做法就是 fresnel = pow(1-|dot(N,V)|, _RimPower=1.9) 再
 *   mix(_MainColor, _TintColor, fresnel)，也就是「中心近乎透明、边缘一圈粉色高光」，
 *   这正好是 CSS radial-gradient 的二维等价物。粉是 _TintColor rgb(0.925,0.494,0.559)
 *   ≈ #EC7E8F @ alpha 0.565。
 *
 * 上下不封口靠 mask 的 linear-gradient 实现：球面极角 θ 处的 y = cosθ，
 *   0°~130° → y ∈ [-0.643R, 1R] → 盒内 0% ~ 82%，即下球冠（82% 以下）切掉
 * 再叠一层 radial-gradient mask 把方形裁成圆，才是"球壳"而不是"色块"。
 */
function yaoEnsureFupaoStyle() {
	if (typeof document === "undefined" || document.getElementById(YAO_FX_STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = YAO_FX_STYLE_ID;
	style.textContent = `
.${YAO_FX_CLASS} {
	position: absolute;
	left: 50%;
	top: 50%;
	/* 尺寸**跟着武将卡片走**：--fx-size 是「球壳直径 = 卡片宽度的百分之多少」，
	   默认 168% ≈ 卡片高度（卡片 120×200），也就是竖着正好从卡顶罩到卡底，
	   左右各溢出 40px 左右；卡片尺寸变了球壳自动跟着变。
	   aspect-ratio 保证是正圆，居中用负 margin（百分比 margin 按包含块宽度算），
	   把 scale 空出来给动画用。--fx-size / --fx-rise 由 yaoSetFupaoFx 按扩展设置写在内联样式上。 */
	width: var(--fx-size, 168%);
	aspect-ratio: 1 / 1;
	margin-left: calc(var(--fx-size, 168%) / -2);
	margin-top: calc(var(--fx-size, 168%) / -2);
	/* 不能挡住头像的点击（点头像是查看武将） */
	pointer-events: none;
	z-index: 6;
	/* 生长：规格 SizeOverLifetime (0,0.341) -> (0.29,0.889) -> (1,1)，
	   时长 = startLifetime 0.5s，段间按规格 3.4(d) 的建议用 easeOutCubic。
	   ★ 整壳**不做**上下浮动的循环动画：实机里泡泡是钉在干员身上的，
	   浮起来会跟卡片脱节；动的只有里面的鱼和气泡。 */
	animation: yaoFupaoGrow 0.5s both;
}
/* 三层共用：铺满容器 + 裁成正圆 */
.${YAO_FX_CLASS} > i {
	position: absolute;
	inset: 0;
	display: block;
	border-radius: 50%;
}
/* ★ 权重问题：layout.css 里有一条「.player > div」的 z-index 规则，
   选择器是「一个类 + 一个标签」，比上面单类名的 .yao-fupao-fx 更高，会把 z-index 盖回去。
   这里用同样含 .player 的选择器提权重，保证球壳画在武将卡**之上**
   （实机里泡泡就是罩在干员身上的，压在下面会看不到边缘）。 */
.player > .${YAO_FX_CLASS} {
	z-index: 7;
}
/* ② 球壳本体。原来是用 radial-gradient 现画的"菲涅尔壳"，现在换成作者画好的香皂泡图
   （虹彩边缘 + 全透明中心，比渐变真实得多）。
   尺寸：图 242×273、球体直径 216px 且圆心就在图中心，
   所以图宽取 242/216 = 112% 时球的直径正好等于球壳容器（--fx-size 那层）。
   "球壳浓度"（--fx-shell）乘的还是整层的 opacity，所以调浓只改不透明度、不改颜色。
   注意要把通用规则里的 border-radius:50% 去掉 —— 那会把图的四角裁成椭圆。 */
.${YAO_FX_CLASS} > .yao-fupao-core {
	position: absolute;
	left: 50%;
	top: 50%;
	right: auto;
	bottom: auto;
	width: 112%;
	aspect-ratio: 242 / 273;
	translate: -50% -50%;
	border-radius: 0;
	background-image: url("${YAO_SHELL_URL}");
	background-repeat: no-repeat;
	background-position: center;
	background-size: 100% 100%;
	opacity: var(--fx-shell, 1);
}
/* ⑤ 右上角高光（assets tex\haruka_07.png，三道渐细的白弧，原作挂在 "wall flow 01" 上）。
   放在球壳右上方压着边缘，用 screen 叠加提亮；慢慢明灭，免得看起来像贴纸。 */
.${YAO_FX_CLASS} > .yao-fupao-glint {
	position: absolute;
	left: 64%;
	top: 28%;
	width: var(--size);
	aspect-ratio: 1 / 1;
	translate: -50% -50%;
	/* 贴图本身是"左下 → 右上"走向的三道白弧，作者要求左右反向，
	   所以这里 scale: -1 1 镜像一下（scale 是最内层变换，不影响上面的位置和旋转） */
	scale: -1 1;
	rotate: -8deg;
	background-image: url("${YAO_GLINT_URL}");
	background-repeat: no-repeat;
	background-position: center;
	background-size: contain;
	mix-blend-mode: screen;
	animation: yaoFupaoGlint 5.5s ease-in-out infinite;
}
/* ③ 金鱼（对应默认皮肤的 zt_yu 节点）。
   贴图是作者用 PS 沿球壳边缘拉伸变形做好的一张图：277×345，里面上、下两条鱼
   已经分别在圆弧的两侧，鱼环圆心就在图中心（实测偏差 0.5px）。
   所以这一层简单得出奇 —— 整张图居中、绕自身中心（= 球心）转就行：
     --w  = 贴合半径 × 1.918，把图里的鱼环（平均半径 144.4px）放大到目标半径上
     旋转就是那两条鱼"一上一下对角转"
   之前用「切成 10 片、每片按圆心角摆到半径上」的近似方案已经不需要了。 */
.${YAO_FX_CLASS} > .yao-fupao-fish {
	position: absolute;
	left: 50%;
	top: 50%;
	width: var(--w);
	aspect-ratio: 277 / 345;
	translate: -50% -50%;
	background-image: url("${YAO_FISH_URL}");
	background-repeat: no-repeat;
	background-position: center;
	background-size: 100% 100%;
	opacity: var(--op);
	/* reverse：图里的鱼是朝逆时针方向的（上边那条头朝左、下边那条头朝右），
	   逆时针公转鱼头才一直朝着前进方向 */
	animation: yaoFupaoOrbit var(--dur) linear infinite reverse;
}
/* ④ 小白泡（对应 bubble 粒子：材质 haruka_46 + bubble_01 贴图，3×3 序列帧）。
   和鱼同一套三层结构：外层给方位角，中层推到半径 --r 上，本体居中。
   贴图本身是偏暖的白水花，用 brightness(0)+invert(1) 压成纯白，更像游戏里那一圈小白泡。
   动画放在最外层 i 上、动的是 translate（不是 scale）：
   translate 在父级坐标系里，所以泡泡是**屏幕竖直方向往上飘**；
   飘的同时淡入淡出，到顶刚好透明、回到起点重新淡入，循环看不出接缝。
   （一开始写成原地做 0.72 倍的大小脉动，幅度太小，实机上等于没动。） */
.${YAO_FX_CLASS} > .yao-fupao-bubble {
	position: absolute;
	inset: 0;
	rotate: var(--a);
	animation: yaoFupaoBubbleRise var(--dur) linear infinite;
	animation-delay: var(--delay);
}
.${YAO_FX_CLASS} .yao-fupao-bubble > u {
	position: absolute;
	inset: 0;
	display: block;
	translate: 0 calc(-1 * var(--r));
}
.${YAO_FX_CLASS} .yao-fupao-bubble b {
	position: absolute;
	left: 50%;
	top: 50%;
	width: var(--s);
	aspect-ratio: 1 / 1;
	margin-left: calc(var(--s) / -2);
	margin-top: calc(var(--s) / -2);
	background-image: url("${YAO_BUBBLE_URL}");
	background-repeat: no-repeat;
	/* 3×3 图集：把整张图放大到 3 倍元素大小，一个格子正好一格 */
	background-size: 300% 300%;
	filter: brightness(0) invert(1);
}
/* ①② 的"缺下球冠"：网格极角只到 130°，cos130° ≈ -0.643 → 盒内 82% 以下没有面。
   实测实机里那道粉色亮边是一整圈闭合的，真按 130° 切掉底部会看成一个"碗"，
   所以这里不切，直接给完整正圆。 */

.${YAO_FX_CLASS}.${YAO_FX_OUT_CLASS} {
	/* 消失 = 规格时间轴里的「SizeOverLifetime 反向收缩」，不是原地淡出 */
	animation: yaoFupaoShrink 0.32s ease-in both;
}
/* 动画属性分工：各层用各自独立的变换属性（scale / translate / rotate），
   不挤在同一个 transform 上，否则后一个会覆盖前一个。
   注意别给 .yao-fupao-fx 本身再加 translate —— 那会让整壳上下浮动。 */
@keyframes yaoFupaoGrow {
	0% {
		scale: 0.341;
		opacity: 0;
		animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
	}
	29% {
		scale: 0.889;
		opacity: 0.95;
		animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
	}
	100% {
		scale: 1;
		opacity: 1;
	}
}
@keyframes yaoFupaoShrink {
	0% {
		scale: 1;
		opacity: 1;
	}
	100% {
		scale: 0.341;
		opacity: 0;
	}
}
@keyframes yaoFupaoOrbit {
	to {
		rotate: 360deg;
	}
}
@keyframes yaoFupaoBubbleRise {
	0% {
		translate: 0 0;
		opacity: 0;
	}
	14% {
		opacity: var(--op);
	}
	76% {
		opacity: var(--op);
	}
	100% {
		translate: 0 calc(-1 * var(--fx-rise, 9%));
		opacity: 0;
	}
}
@keyframes yaoFupaoGlint {
	0%,
	100% {
		opacity: 0.62;
	}
	50% {
		opacity: 1;
	}
}
`;
	document.head.appendChild(style);
}

/** 给某角色挂上 / 取下浮泡特效 */
function yaoSetFupaoFx(player, on) {
	if (!player || !player.node) {
		return;
	}
	yaoEnsureFupaoStyle();
	// ★ 挂在**卡片本身**（.player），不要挂 node.avatar。
	// .avatar 是 overflow: hidden 的，而球壳直径约卡片宽度的 1.6 倍，
	// 超出部分（左右各 35px 左右）会被直接裁掉，只剩中间那片「近乎透明」的区域，
	// 看上去就跟没生效一样。`.player` 的 overflow 是 visible，能把球壳完整罩到卡片外。
	const box = player;
	let fx = box.querySelector("." + YAO_FX_CLASS);
	if (on) {
		if (fx) {
			// 已经在了（比如正在播消失动画）：把它拉回来
			fx.classList.remove(YAO_FX_OUT_CLASS);
			return;
		}
		fx = document.createElement("div");
		fx.className = YAO_FX_CLASS;
		yaoBuildFupaoFx(fx);
		box.appendChild(fx);
		yaoPlayFupaoSfx("浮泡生成");
	} else if (fx) {
		// 先播一小段反向收缩，再从 DOM 里摘掉（0.32s 动画 + 一点余量）
		fx.classList.add(YAO_FX_OUT_CLASS);
		setTimeout(() => fx.remove(), 360);
		yaoPlayFupaoSfx("浮泡消失");
	}
}

/**
 * 按当前扩展设置把特效内容填进 fx 节点。
 * 单独抽出来是为了「改完设置立刻生效」：yaoRefreshAllFupaoFx 会拿同一套代码重建。
 */
function yaoBuildFupaoFx(fx) {
	const opt = yaoFxOptions();
	// 尺寸 / 浓度 / 上升高度走 CSS 变量，样式表里只写结构
	fx.style.setProperty("--fx-size", opt.sizePct + "%");
	fx.style.setProperty("--fx-rise", opt.bubbleRise + "%");
	fx.style.setProperty("--fx-shell", String(opt.shell));
	// 球壳 + 右上高光 + 金鱼 + 小气泡，DOM 顺序 = 由内到外
	// （鱼和泡泡画在球壳之上，球壳中心本来就是透明的，所以看起来就在泡里）
	fx.innerHTML =
		'<i class="yao-fupao-core"></i>' + yaoGlintHtml(opt) + yaoFishHtml(opt) + yaoBubbleHtml(opt);
	return opt;
}

/**
 * 改完扩展设置后，把场上已经挂着的浮泡按新参数重建一遍。
 * 重建会顺带重启生长动画 —— 就当是"重新生成一次泡泡"，代价小、也不会残留旧尺寸。
 * 挂在 game 上，好让 extension.js 里的 config.onclick 能调到（那边加载时机更早）。
 */
function yaoRefreshAllFupaoFx() {
	if (typeof document === "undefined") {
		return;
	}
	document.querySelectorAll("." + YAO_FX_CLASS).forEach(fx => {
		fx.classList.remove(YAO_FX_OUT_CLASS);
		// 去掉内联的 animation-delay 之类残留，重建内容
		yaoBuildFupaoFx(fx);
	});
}
game.yaoRefreshAllFupaoFx = yaoRefreshAllFupaoFx;

/**
 * 这个角色现在是不是由 AI 在决策（含玩家开了自动 / 托管的情况）。
 *
 * ★ 判据必须用 `player.isMine()`，**绝对不能**用 `!player.isUnderControl()`。
 *   不带参数调用 `isUnderControl()` 时，引擎对「自己」返回的是 **false**
 *   （见 player.js 的 isUnderControl：
 *       `if (this === me) { if (self) return true; return false; }`
 *    —— 它的语义是「我是否控制着这个**别的**角色」），取反之后
 *   **玩家本人会被当成 AI**。
 *
 *   这个坑实机踩过两次：
 *     · 结城理的「卖血」判断因此对玩家本人生效；
 *     · 煌【链锯】的「血少别冒险」判断也因此对玩家本人生效 ——
 *       煌被打到 2 血之后，技能按钮就再也点不亮了（两次 bug 报告都是它）。
 *       ★ 那道闸门后来被作者整个撤掉了（血少恰恰是煌最该出手的时候），
 *         所以现在这个判据只剩结城理在用（jyclIsAuto）。
 *
 *   `player.isMine()` 才是引擎里「这个角色正由我手动操作」的正解
 *   （player.js 末段）：
 *       return this == game.me && !_status.auto && !this.isMad() && !game.notMe;
 *
 *   注意也别用 `isUnderControl(true)`：那条路对「自己」直接返回 true，
 *   **不看 `_status.auto`**，区分不了托管。
 */
function isAutoPlayer(player) {
	return !player.isMine();
}

/** 结城理专用的历史别名，含义与 isAutoPlayer 完全一致 */
function jyclIsAuto(player) {
	return isAutoPlayer(player);
}

/**
 * 【捉迷藏】的合法目标。
 *
 * 描述是「选择一名与你距离不大于1的**已受伤**角色，令其回复1点体力」，
 * 但技能会**先让乌啾自己失去 1 点体力**再回复 —— 选自己时，
 * 「已受伤」应当按**扣血之后**的状态算：她失去这 1 点就已经受伤了，
 * 这一下回复才有意义（也正好借这次 recover 去触发【迷彩】的判定）。
 * 所以目标是**自己**时不受「已受伤」限制。
 *
 * 别的角色不因这个技能掉血，「已受伤」的限制照旧。
 * （自己到自己的距离是 0，天然满足「不大于1」。）
 */
function wjZhuomicangTargetable(player, target) {
	if (!target || !target.isAlive()) {
		return false;
	}
	if (target == player) {
		return true;
	}
	return target.isDamaged() && get.distance(player, target) <= 1;
}

// ══════════════════════════════════════════════════════════════════
// 涤火杰西卡 —— 【舰炮】的 X
//
// X 的定义是「你本局游戏使用该技能的次数」，一旦涨上去就不该回落，
// 所以**不能**蹭 engine 的 getStat("skill")：那个会被「重置技能」清掉
// （正是〖步銃〗要的效果，但〖舰炮〗不要），必须自己开一个 storage 记。
// ══════════════════════════════════════════════════════════════════

/** 【舰炮】的 X：你本局游戏使用该技能的次数 */
function dhjxkJianpaoUsed(player) {
	return player.storage.dhjxk_jianpao_count || 0;
}

/** 【舰炮】这一发要弃几张：4 - X，最少 0 张（X ≥ 4 时就不再弃牌了） */
function dhjxkJianpaoNeed(player) {
	return Math.max(0, 4 - dhjxkJianpaoUsed(player));
}

/**
 * 【舰炮】弃的牌必须「花色不同」，所以真正决定能不能发动的不是**牌数**，
 * 而是手牌 + 装备区里能凑出多少**种花色**。
 *
 * 例：X = 0 时要弃 4 张花色不同的牌，手里捏着四张 ♠ 是不够的 ——
 * 只看 countCards 的话技能会亮起来，点进去却发现怎么选都凑不满。
 * 所以 filter 必须按花色种数判，跟 filterCard 用的是同一套 `get.suit(card, player)`
 * （这样 mod.suit 那类「黑桃视为红桃」的改写也被算进去）。
 */
function dhjxkJianpaoSuits(player) {
	const suits = new Set();
	for (const card of player.getCards("he")) {
		const suit = get.suit(card, player);
		if (suit && suit != "none") {
			suits.add(suit);
		}
	}
	return suits.size;
}

// ══════════════════════════════════════════════════════════════════
// 均（相见欢 / 律法）· 重岳 · 颉 · 黍 —— 模块级工具
//
// 五个干员各自的长篇说明写在下面技能块的开头，这里只放**跨技能共用**的
// 常量与函数。
// ══════════════════════════════════════════════════════════════════

// ── 「阶段」的通用工具（均 · 相见欢 的三个技能共用）─────────────────
//
// 一个回合就是一次 `phase` 事件，它的 `phaseList` 数组决定
// 判定 / 摸牌 / 出牌 / 弃牌 的执行顺序（见 library/element/content.js 的 phase）。
//
// 它在**阶段真正开始跑之前**都还能改：phase 的 content 第 2 步才
// `event.phaseList ??= [...默认顺序]`，读它却要等到第 9 步 `event.phaseList[num]`。
// 所以挂在 `phaseBegin` 时机去改，改的就是本回合。
//
// 「少执行一个阶段」则完全不碰 phaseList —— 调 `player.skip("phaseUse")` 把阶段名
// 塞进 `player.skipList`，阶段事件轮到自己时由 `checkSkipped` 吃掉并 finish
// （见 library/element/gameEvent.js 第 258 行）。
//
// ★ 顺带白送一条：「乐不思蜀 / 兵粮寸断影响的阶段若已执行，则顺延至下一回合」。
//   乐不思蜀的 effect() 也是调 `player.skip("phaseUse")`，而 skipList **不会**
//   在回合结束时清空（只有 player.init 清），所以本回合已经跑过的出牌阶段接不到
//   这一跳；它会一直躺着，等下一回合重建出牌阶段事件时再被吃掉。
//   换句话说：只要把判定阶段挪到出牌阶段后面，乐不思蜀就自动变成「下回合生效」。
const XJH_PHASES = ["phaseJudge", "phaseDraw", "phaseUse", "phaseDiscard"];

const XJH_PHASE_TEXT = {
	phaseJudge: "判定阶段",
	phaseDraw: "摸牌阶段",
	phaseUse: "出牌阶段",
	phaseDiscard: "弃牌阶段",
};

/** 当前回合的 phase 事件；不在回合里就返回 null */
function xjhPhaseEvent(from) {
	const evt = from || _status.event;
	if (!evt || typeof evt.getParent != "function") {
		return null;
	}
	return evt.getParent("phase") || null;
}

/**
 * 把 phaseList 里那四个阶段的**位置**按 order 重排。
 * 准备 / 结束阶段，以及带 `|理由` 后缀的条目，位置一律原地不动 ——
 * 只是把四个「槽」里的名字换掉。
 */
function xjhReorderPhase(phase, order) {
	if (!phase || !Array.isArray(phase.phaseList) || !Array.isArray(order) || order.length != XJH_PHASES.length) {
		return false;
	}
	const slots = [];
	for (let i = 0; i < phase.phaseList.length; i++) {
		if (XJH_PHASES.includes(String(phase.phaseList[i]).split("|")[0])) {
			slots.push(i);
		}
	}
	if (slots.length < order.length) {
		return false;
	}
	order.forEach((name, i) => {
		phase.phaseList[slots[i]] = name;
	});
	return true;
}

/**
 * 问玩家「这四个阶段按什么顺序执行」，返回排好的四个阶段名（取消则返回 null）。
 *
 * 无名杀没有现成的排序界面（chooseToMove 至少要两个列表才动得起来），
 * 所以这里退化成三次 `chooseControl`：第一次挑第 1 个执行的，第二次挑第 2 个……
 * 剩下最后一个不用问。中途取消就整件事作废，顺序保持默认。
 */
async function xjhChoosePhaseOrder(player, prompt) {
	const pool = XJH_PHASES.slice();
	const order = [];
	while (pool.length > 1) {
		const result = await player
			.chooseControl(pool, "cancel2")
			.set("prompt", `${prompt}：选择第${get.cnNumber(order.length + 1)}个执行的阶段`)
			.set(
				"choiceList",
				pool.map(name => XJH_PHASE_TEXT[name])
			)
			.set("ai", () => (pool.includes("phaseUse") ? "phaseUse" : pool[0]))
			.forResult();
		if (!result || !result.control || result.control == "cancel2" || !pool.includes(result.control)) {
			return null;
		}
		order.push(result.control);
		pool.remove(result.control);
	}
	order.push(pool[0]);
	return order;
}

/**
 * 让某个人**额外执行一个指定的阶段**。
 *
 * player.insertPhase 会新建一次完整的 phase 事件插到当前事件之后，
 * 而它的 phaseList 默认是六个阶段全的 —— 所以这里抢在 phase 的 content 跑之前
 * 把它改成只有一个阶段（引擎那步写的是 `event.phaseList ??= [...]`，非空就照用）。
 */
function xjhInsertPhase(player, phaseName, skill) {
	const next = player.insertPhase(skill || "xjh_zhiqian");
	next.phaseList = [phaseName];
	return next;
}

/** 「每轮限一次」的手动计数（引擎的 `round` 字段对 enable 技能不生效，只能自己记） */
function xjhRoundFree(player, skill) {
	return player.storage[`${skill}_roundused`] !== game.roundNumber;
}

function xjhMarkRound(player, skill) {
	player.storage[`${skill}_roundused`] = game.roundNumber;
}

// ── 「签」（均 · 相见欢）───────────────────────────────────────────
//
// 「签」是**牌标记**（gaintag），不是角色标记 —— 它必须跟着牌走：
//   · 在别人手里时，是一张「回合外不能使用 / 打出 / 弃置」的手牌；
//   · 被【掷签】收上武将牌之后，又变成一枚可以弃置掉的标记。
// gaintag 是唯一同时满足这两种形态的载体（牌进了扩展区还在），
// 引擎还会把 get.translation(tag) 渲染到牌面上，玩家一眼看得见。
const XJH_QIAN = "xjh_qian";

/** 一张牌是不是「签」 */
function xjhIsQian(card) {
	return !!(card && typeof card.hasGaintag == "function" && card.hasGaintag(XJH_QIAN));
}

/**
 * 一张「签」现在该不该被封住。
 *
 * 描述是「拥有签的角色**不可因在回合之外**打出或弃置签」——
 * 约束的是**牌的持有者**，不是正在动手的人（别人用【过河拆桥】拆它也不行）。
 * 所以这里要问 get.owner(card)，而不是 mod 拿到的 player 参数（那是操作者）。
 */
function xjhQianSealed(card) {
	if (!xjhIsQian(card)) {
		return false;
	}
	const owner = get.owner(card);
	if (!owner) {
		return false;
	}
	return _status.currentPhase != owner;
}

/**
 * 从一个 lose 事件里挑出「刚刚进了弃牌堆的签」。
 *
 * 判据是 `get.position(card) == "d"` —— loseAfter 触发时牌已经挪完窝了，
 * 所以这时候问位置才是准的。lose 系列事件的字段名五花八门
 * （cards / hs / es / js …，见辉夜 kgyLostShenbao 里那份清单），
 * 干脆全部扫一遍去重。
 */
function xjhQianDiscarded(event) {
	const list = [];
	const push = card => {
		if (xjhIsQian(card) && get.position(card) == "d" && !list.includes(card)) {
			list.push(card);
		}
	};
	for (const key of ["cards", "hs", "es", "js", "ss", "xs", "cards2"]) {
		const arr = event[key];
		if (Array.isArray(arr)) {
			arr.forEach(push);
		}
	}
	return list;
}

// ── 「史」「损」「书刀」（颉）──────────────────────────────────────
const JIE_SHI = "jie_zhengshi";
const JIE_SUN = "jie_sun";
const JIE_MINGZHE = "jie_mingzhe";
const JIE_SHOUDAO = "jie_shudao";

/** 颉那本账上有几枚「史」 */
function jieShiCount(player) {
	return player.countMark(JIE_SHI);
}

/** 颉的武将牌上有几张「损」 */
function jieSunCount(player) {
	return player.countExpansions(JIE_SUN);
}

/** 弃牌堆里的所有牌（ui.discardPile 的子节点本身就是 Card 实例） */
function jieDiscardPile() {
	if (!ui.discardPile || !ui.discardPile.childNodes) {
		return [];
	}
	return Array.from(ui.discardPile.childNodes);
}

/**
 * 【正史】能从弃牌堆里挑的牌。
 *
 * 描述是「从弃牌区中选择一张**非装备牌**并**视为使用**之」—— 原稿那句
 * 「非装备牌……装备之」本来就自相矛盾，作者后来把动词一并改成了「视为使用」。
 * 所以这里筛的是非装备牌，而且必须**当下真的用得出**：【闪】【无懈可击】这类
 * 只能用来响应的牌 hasUseTarget 为假，会自动出局，免得玩家挑到一张根本打不出去
 * 的牌、白白丢掉一枚「史」。
 */
function jieZhengshiPool(player) {
	return jieDiscardPile().filter(card => get.type(card) != "equip" && player.hasUseTarget(card, null, true));
}

/**
 * 从一次 lose 事件里挑出「以【正史】使用、刚刚落进弃牌堆的那张牌」。
 *
 * 判据与 xjhQianDiscarded 同一套：loseAfter 触发时牌已经挪完窝了，所以这时候
 * 问 get.position(card) 才是准的；lose 系列事件的字段名五花八门，干脆全扫一遍。
 */
function jieZhengshiOut(event) {
	const list = [];
	const push = card => {
		if (card && card.storage && card.storage.jie_zhengshi_out && get.position(card) == "d" && !list.includes(card)) {
			list.push(card);
		}
	};
	for (const key of ["cards", "hs", "es", "js", "ss", "xs", "cards2"]) {
		const arr = event[key];
		if (Array.isArray(arr)) {
			arr.forEach(push);
		}
	}
	return list;
}
/**
 * 【明哲】的使命判定 —— 「谁先达标算谁」。
 *
 * 史和损的每一次变化都只发生在【正史】那几处记账里，所以判定就挂在记账的
 * 当口顺手跑一遍，不再另挂一堆触发时机。
 *
 * ★ 判定完（无论成败）都会走 awakenSkill，而 awakenSkill 内部是
 *   disableSkill(主技能名 + "_awake", 主技能名)，所以事后 hasSkill 变 false，
 *   这个函数天然只会真正生效一次，不需要额外的防重入标记。
 */
async function jieCheckMingzhe(player) {
	if (!player.hasSkill(JIE_MINGZHE)) {
		return;
	}
	if (jieShiCount(player) >= game.countPlayer()) {
		game.log(player, "成功完成使命");
		player.awakenSkill(JIE_MINGZHE);
		await player.addSkills("jie_baoshen");
		return;
	}
	if (jieSunCount(player) >= 5) {
		game.log(player, "使命失败");
		player.awakenSkill(JIE_MINGZHE);
		// 「立即失去所有体力」：一下把当前体力全丢掉，进了濒死能不能救回来是另一回事
		await player.loseHp(player.hp);
	}
}

/** 记一枚「史」，并把【明哲】的判定带上 */
async function jieAddShi(player, reason) {
	player.addMark(JIE_SHI, 1);
	game.log(player, `获得了1枚「史」${reason ? `（${reason}）` : ""}`);
	await jieCheckMingzhe(player);
}

// ── 「种」「禾」（黍）──────────────────────────────────────────────
const SHU_ZHONG = "shu_zhong";
const SHU_HE = "shu_he";

/**
 * 「禾」牌面上的归属标注。
 *
 * 作者要求：移除「禾」的时候要能看出这张禾是谁的 —— 秋收的选牌界面里几张
 * 「禾」长得一模一样。做法是给牌挂一个 gaintag，内容直接就是持有者的武将名
 * （gaintag 的显示走 get.translation，中文名没有对应词条，会原样显示出来）。
 * 牌一离开武将牌就把标注摘掉，免得它洗回牌堆、再被人摸到手里时牌面上还写着名字。
 */
function shuMarkHeOwner(card, holder) {
	if (!card || !holder) {
		return;
	}
	if (!card.storage) {
		card.storage = {};
	}
	card.storage.shu_he_owner = holder.playerid;
	card.addGaintag(get.translation(holder));
}

/** 摘掉「禾」的归属标注 */
function shuClearHeOwner(card) {
	if (!card || !card.storage || card.storage.shu_he_owner == null) {
		return;
	}
	const holder = game.players.concat(game.dead || []).find(current => current.playerid == card.storage.shu_he_owner);
	if (holder) {
		card.removeGaintag(get.translation(holder));
		// 这一枚离开了武将牌，它的标记就没东西可显示 —— 但上限为 3，
		// 身上可能还留着别的种 / 禾，得按实际剩余张数同步（见 shuSyncMark）
		shuSyncMark(holder);
	}
	delete card.storage.shu_he_owner;
}

/**
 * 按武将牌上实际剩下的牌，同步「种」「禾」两个标记技能的挂载。
 *
 * 共用上限为 3 之后，一个人身上可能同时扣着好几张（种 + 禾），
 * 挪走一张时就**不能**再无条件 removeSkill —— 否则剩下的那几张
 * 就不显示标记了。凡是「种 / 禾 张数可能变化」的地方都该过一遍这里。
 */
function shuSyncMark(player) {
	if (!player) {
		return;
	}
	for (const tag of [SHU_ZHONG, SHU_HE]) {
		if (player.countExpansions(tag) > 0) {
			player.addSkill(tag);
		} else {
			player.removeSkill(tag);
		}
	}
}

/** 一次 lose 事件里「刚离开武将牌、却还带着归属标注的禾」 */
function shuHeLeftBoard(event) {
	const list = [];
	const push = card => {
		if (card && card.storage && card.storage.shu_he_owner != null && get.position(card) != "x" && !list.includes(card)) {
			list.push(card);
		}
	};
	for (const key of ["cards", "hs", "es", "js", "ss", "xs", "cards2"]) {
		const arr = event[key];
		if (Array.isArray(arr)) {
			arr.forEach(push);
		}
	}
	return list;
}

/**
 * 满血时也要让 recover 事件真正跑起来。
 *
 * 【枯荣】的溢出转甲挂在 recoverBegin 上，可满血时引擎会在**任何触发之前**先用
 * 事件自带的 filterStop（player.js 里那句 `this.player.isHealthy()`）把整个
 * recover 事件掐掉 —— 于是「桃回的那 1 点」根本读不到，自然也没有护甲；
 * 再加上桃的 enable 本身就是 player.isDamaged()，满血时连牌都点不出去。
 * 这里只给黍的 recover 事件换一个 filterStop：num>0 就放行（content 会把 num
 * 夹成 0，不会凭空加血），num<=0 照旧掐断。其余角色完全不受影响。
 */
function shuPatchRecover() {
	const proto = lib.element && lib.element.player;
	if (!proto || proto.__shuKurongPatched || typeof proto.recover != "function") {
		return;
	}
	const recover = proto.recover;
	proto.recover = function (...args) {
		const next = recover.apply(this, args);
		if (next && next.filterStop && next.num > 0 && typeof this.hasSkill == "function" && this.hasSkill("shu_kurong") && this.isHealthy()) {
			next.filterStop = function () {
				if (this.num <= 0) {
					delete this.filterStop;
					this.finish();
					this._triggered = null;
					return true;
				}
			};
		}
		return next;
	};
	proto.__shuKurongPatched = true;
}

shuPatchRecover();

/**
 * 让黍「回复体力」，并把超出体力上限的部分转成护甲（【枯荣】）。
 *
 * 满血时**不能**指望 `player.recover()`：引擎会在任何触发之前用事件自带的
 * filterStop（`this.player.isHealthy()`）把整个 recover 事件掐掉，
 * `recoverBegin` 根本不跑，溢出量自然读不到 —— 于是「翻面成禾，黍回复1点」
 * 在满血时什么也不会发生。shuPatchRecover 是给【桃】这类**外部**回复留的兜底；
 * 技能自己发起的回复走这里，溢出量一目了然、直接结账。
 *
 * 不满血时照旧交给 `player.recover()`：那时事件能正常跑完，溢出由
 * recoverBegin 上的 shu_kurong_over 处理（两条路互斥，不会重复加甲）。
 */
async function shuRecover(player, num = 1) {
	if (!player || !player.isIn()) {
		return;
	}
	if (player.hp >= player.maxHp) {
		const over = Math.min(num, player.hp + num - player.maxHp);
		if (over > 0) {
			game.log(player, `回复溢出${get.cnNumber(over)}点，转化为护甲`);
			await player.changeHujia(over);
		}
		return;
	}
	await player.recover(num);
}

// ── 【定法】的十条律法（均 · 律法）────────────────────────────────
//
// 文案顺序与作者描述文件里的编号一一对应（下标 +1 就是规则号）。
const LF_RULE_TEXT = [
	"摸牌阶段多摸两张牌，回合内不可打出【杀】",
	"摸牌阶段少摸一张牌",
	"击杀角色时需弃置所有手牌",
	"装备装备牌时，需弃一张牌",
	"使用锦囊牌时，需弃一张牌",
	"弃牌阶段，不可弃置大于三张牌",
	"使用【酒】后不可出【杀】",
	"累计使用三张锦囊牌时，需直接进入弃牌阶段",
	"当你对他人造成伤害时，需弃置一张手牌",
	"你使用技能时，需弃置一张牌",
];

/**
 * 当前还生效的规则编号。
 *
 * 数据存在 player.storage.lf_dingfa_rules = [{ rule, until }, ...]，
 * until 是「生效到第几轮为止」。顺手把过期的摘掉，免得越堆越多。
 */
function lfRuleActive(player) {
	const list = player.storage.lf_dingfa_rules;
	if (!Array.isArray(list) || !list.length) {
		return [];
	}
	const live = list.filter(item => item && typeof item.until == "number" && item.until >= game.roundNumber);
	if (live.length != list.length) {
		player.storage.lf_dingfa_rules = live;
	}
	return live.map(item => item.rule);
}

function lfHasRule(player, rule) {
	return lfRuleActive(player).includes(rule);
}

/** 「需弃置一张牌」的通用结算：弃不出来就按「违反」失去 1 点体力 */
async function lfPayCard(player, reason, position) {
	const area = position || "he";
	if (!player.countCards(area)) {
		game.log(player, `因律法「${reason}」需弃置一张牌，但无牌可弃`);
		await player.loseHp(1);
		return;
	}
	const result = await player
		.chooseToDiscard(1, true, area)
		.set("prompt", `律法：因「${reason}」需弃置一张牌`)
		.set("ai", card => -get.value(card))
		.forResult();
	if (!result.bool || !result.cards || !result.cards.length) {
		await player.loseHp(1);
	}
}

/**
 * 规则⑩「你使用技能时，需弃置一张牌」的钩子。
 *
 * ★ 为什么非得包核心函数：无名杀**没有**任何通用的「使用技能」时机。
 *   引擎的 useSkill 事件全场只有两个调用点（都在 chooseToUse 那条路上），
 *   触发技根本不走它；而 player.logSkill 是所有技能发动的必经之路。
 *   这是本扩展继 lib.filter.cardSavable、game.playAudio 之后的第三处核心包装，
 *   同样只包一次、幂等（见 main/content.js 里那两处的说明）。
 *
 * ★ 这里**不弹对话框**：logSkill 是在别人事件的 content 中途被调的，
 *   在那个位置插一个需要玩家操作的 chooseToDiscard 风险太大
 *   （事件链、动画、联机同步都容易出岔子）。所以改成自动弃掉价值最低的一张，
 *   弃不出来（无牌可弃）才失去 1 点体力。代价是玩家没法自己挑弃哪张。
 */
function lfHookLogSkill() {
	if (game.__arknightsLogSkillHooked || !lib.element || !lib.element.player || !lib.element.player.logSkill) {
		return;
	}
	game.__arknightsLogSkillHooked = true;
	const logSkill = lib.element.player.logSkill;
	lib.element.player.logSkill = function (name, ...rest) {
		const result = logSkill.apply(this, [name, ...rest]);
		try {
			lfDingfaSkillTax(this, name);
		} catch (e) {
			// 记账失败不该把游戏带崩
		}
		return result;
	};
}

function lfDingfaSkillTax(player, skill) {
	if (!player || !skill || typeof skill != "string") {
		return;
	}
	if (!lfHasRule(player, 10)) {
		return;
	}
	// 自己的律法不向自己收税，否则【定法】一立规矩就先罚自己一次
	if (skill.startsWith("lf_dingfa")) {
		return;
	}
	const cards = player.getCards("he");
	if (!cards.length) {
		game.log(player, "因律法「使用技能时需弃置一张牌」而无牌可弃");
		player.loseHp(1);
		return;
	}
	let worst = cards[0];
	for (const card of cards) {
		if (get.value(card) < get.value(worst)) {
			worst = card;
		}
	}
	game.log(player, "因律法「使用技能时需弃置一张牌」弃置了一张牌");
	player.discard(worst);
}

// ── 「戍」（重岳）──────────────────────────────────────────────────

/** 这里是不是有一张刚进弃牌堆的装备牌（【正史】的记账用） */
function jieEquipDiscarded(event) {
	if (!event) {
		return 0;
	}
	const seen = [];
	let num = 0;
	for (const key of ["cards", "hs", "es", "js", "ss", "xs", "cards2"]) {
		const arr = event[key];
		if (!Array.isArray(arr)) {
			continue;
		}
		for (const card of arr) {
			if (!card || seen.includes(card)) {
				continue;
			}
			seen.push(card);
			if (get.position(card) == "d" && get.type(card) == "equip") {
				num++;
			}
		}
	}
	return num;
}

/** 谁使用了限定技 → 场上每一位颉各记一枚「史」 */
function jieNotifyLimited(user) {
	for (const current of game.players.concat(game.dead || [])) {
		if (!current.hasSkill(JIE_SHI)) {
			continue;
		}
		current.addMark(JIE_SHI, 1);
		game.log(current, "因", user, "使用了限定技而获得了1枚「史」");
		jieCheckMingzhe(current);
	}
}

// ── 「戍」（重岳）──────────────────────────────────────────────────

/**
 * 给某人压一枚「戍」。
 *
 * 「判定区不可放置其他牌或标记，若有则弃置之」拆成两步：
 *   ① 先把判定区里现有的牌弃掉；
 *   ② 再 `disableJudge()` 把整个判定区废置 ——
 *      `lib.filter.judge` 第一句就是 `target.canAddJudge(card, player)`，
 *      而它开头直接查 `isDisabledJudge()`，所以废置之后任何延时锦囊都放不进来。
 * 离场（zy_shu 的回合结束分支）时 `enableJudge()` 还原。
 */
async function zyShuPlace(owner, target) {
	target.storage.zy_shu_owner = owner.playerid;
	target.storage.zy_shu_weak = false;
	const js = target.getCards("j");
	if (js.length) {
		await target.discard(js);
	}
	target.addSkill("zy_shu");
	await target.disableJudge();
	game.log(owner, "在", target, "的判定区放置了「戍」");
}

/** 「戍」现在归谁（存的是 playerid，联机下 player 对象不能进 storage） */
function zyShuOwner(player) {
	const id = player.storage.zy_shu_owner;
	if (!id) {
		return null;
	}
	return game.players.concat(game.dead || []).find(current => current.playerid == id) || null;
}

/** 场上的「禾」总数（【秋收】的三条加成都看它） */
function shuHeCount() {
	let num = 0;
	for (const current of game.players.concat(game.dead || [])) {
		num += current.countExpansions(SHU_HE);
	}
	return num;
}

/** 这个人武将牌上有没有「禾」 */
function shuHasHe(player) {
	return player.hasExpansions(SHU_HE);
}

/**
 * 【春种】要的是「基本牌」（作者改稿，原稿是♥牌）。
 *
 * get.type 对实体手牌返回 "basic" / "trick" / "equip" / "delay"，
 * 【杀】【闪】【桃】【酒】都是 basic，延时锦囊则是 delay。
 */
function shuIsBasic(card) {
	return get.type(card) == "basic";
}

/** 「种」「禾」在单张武将牌上的**共用**上限 */
const SHU_MARK_LIMIT = 3;

/**
 * 这个人还能不能再收一枚「种」/「禾」。
 * 作者确认：「种」「禾」在单个武将上的上限**共用**为 3 ——
 * 同一张武将牌上，种和禾加起来最多三枚。
 */
function shuMarkFree(player) {
	return player.countExpansions(SHU_ZHONG) + player.countExpansions(SHU_HE) < SHU_MARK_LIMIT;
}

/** 场上所有武将牌上还没有黍的标记的角色 */
function shuMarkTargets(exclude) {
	return game.filterPlayer(current => current.isIn() && current != exclude && shuMarkFree(current));
}

/**
 * 这张「种」能传到的落脚点：离持有者最近的、武将牌上还接得下的角色，至多两名。
 *
 * 「交出」要求这两个落脚点是**两名不同的**角色，所以这里直接算出完整的一对二
 * 候选 —— 长度不足 2 就说明凑不满，「交出」那个选项当场作废。
 */
function shuPassSpots(holder) {
	return game
		.filterPlayer(current => current.isIn() && current != holder && shuMarkFree(current))
		.sort((a, b) => get.distance(holder, a) - get.distance(holder, b))
		.slice(0, 2);
}

/**
 * 结算持有者身上的**一张**「种」。
 *
 *   交出：再搭一张基本牌手牌，两张凑在一起按距离分给最近的两名角色。
 *         落脚点必须是**两名不同的**角色 —— 凑不满两名时这个选项不可选。
 *   不交出（手上没有基本牌、或凑不满两名去处）：「种」翻面成「禾」，
 *         黍回复 1 点体力。
 *
 * 共用上限改成 3 之后，一张武将牌上可能扣着好几张「种」，所以这里只负责
 * 单张，整轮循环交给 shu_chunzhong_pass.content —— 那就是「逐张结算」。
 */
async function shuPassOne(holder, zhong, player) {
	// ★ 「交出」的两个落脚点不能是同一个人，所以先数清楚能传到几个人
	const spots = shuPassSpots(holder);
	const canPay = holder.countCards("h", shuIsBasic) > 0;
	let pay = null;
	if (canPay) {
		const rest = holder.countExpansions(SHU_ZHONG) - 1;
		// 两个选择的后果都摆进 choiceList —— 光看「再出一张基本牌」这句，
		// 看不出不交会换来什么
		const choiceList = [
			"<b>交出</b>：再搭一张基本牌，和这张<b>「种」</b>凑成两张，分头放到离你最近的<b>两名</b>武将牌上没有黍其他标记的角色那儿。",
			"<b>不交出</b>：此<b>「种」</b>翻面成为<b>「禾」</b>（牌面上会标出它属于谁），黍回复1点体力。",
		];
		// ★ 凑不满两名时，「交出」**不进可点列表**（list），只在 choiceList 里
		//   淡化 —— 玩家看得见、点不着（同涤火杰西卡【整备】的两段式写法）。
		//   别把它塞进 list 再事后拒绝，那只会让玩家白点一次。
		const list = [];
		if (spots.length >= 2) {
			list.push("交出基本牌");
		} else {
			choiceList[0] = `<span style="opacity:0.5">${choiceList[0]}（凑不满两名角色，不能交出）</span>`;
		}
		list.push("不交出");
		const control = await holder
			.chooseControl(list)
			.set("prompt", `春种：是否交出一张基本牌，让「种」传下去？${rest > 0 ? `（武将牌上还有 ${rest} 张「种」）` : ""}`)
			.set("choiceList", choiceList)
			.set("ai", () => (spots.length >= 2 ? "交出基本牌" : "不交出"))
			.forResult();
		if (control.control == "交出基本牌") {
			const result = await holder
				.chooseCard({
					prompt: "春种：再出一张基本牌，让「种」传给离你最近的两名角色",
					position: "h",
					filterCard: shuIsBasic,
				})
				.forResult();
			if (result.bool && result.cards && result.cards.length) {
				pay = result.cards[0];
			}
		}
	}
	if (!pay) {
		// 不传（或交不出去）：翻面成「禾」，黍回复 1 点体力
		zhong.removeGaintag(SHU_ZHONG);
		zhong.addGaintag(SHU_HE);
		shuMarkHeOwner(zhong, holder);
		// 标记跟着从「种」换成「禾」（身上还有别的种时不能摘）
		shuSyncMark(holder);
		game.log(holder, "的「种」翻面，成为「禾」");
		await shuRecover(player, 1);
		return;
	}
	// 传下去：那张基本牌 + 这张「种」凑成两张，分头落到离他最近的两名角色那儿
	await holder.give(pay, player);
	// spots 一定正好两名（凑不满根本走不到这里），cards 也是一对一
	const cards = [pay, zhong];
	for (let i = 0; i < spots.length; i++) {
		const spot = spots[i];
		const card = cards[i];
		const next = spot.addToExpansion([card], card == zhong ? player : holder);
		next.gaintag.add(SHU_ZHONG);
		await next;
		spot.addSkill(SHU_ZHONG);
		player.line(spot, "green");
		game.log(player, "在", spot, "的武将牌上放置了「种」");
	}
	// 这张「种」必定已经离手；身上若还留着别的种，标记得留着
	shuSyncMark(holder);
}

/**
 * 这一下「失去 1 点体力」AI 值不值得点。
 *
 * 结城理三张面具的体力上限都是 1，所以「主动失 1 点」= 当场打进濒死 = 换下一张面具
 * （换牌挂在 dieBefore 上，死亡流程会被截停，手牌不会掉，而且 jyclSwapMask
 *   会按新面具重设体力和上限，也就是**回满**）。于是这笔买卖的账很好算：
 *
 *   面具① → ②   赚：抽一张牌 + 白得一张无距离无次数的【杀】，
 *                 而且②还能让【杀】多打一个目标
 *   面具② → ③   不卖：只换来一张牌，代价却是丢掉②的「杀可双目标」，
 *                 而③唯一的主动效果（每回合回 1 血）根本抵不回这笔账
 *   面具③ → 死   面具③**没有**「死亡时更改武将牌」—— 死在它上面就是真的死了
 *
 * ★ 所以 AI 的口径是「**只**从面具① 卖到面具②，之后就不卖了」，
 *   判据就是「当前戴着的是不是面具①」。人类玩家不受这条限制 ——
 *   `filter` 只在 `jyclIsAuto(player)` 为真时才会走到这里。
 *
 * 另外两个技能的 `ai.order` 都压到 1（最低），让它先把该用的牌用完
 * （尤其是面具②那两张目标的【杀】），最后再回来卖血。
 */
function jyclShouldBleed(player) {
	// 只有面具① → ② 这一跳值得。戴着 ② / ③ 时 AI 一律停手。
	if (!player.hasSkill("jycl_mianju_a")) {
		return false;
	}
	// 已经空血 / 濒死，别再踩一脚
	if (player.hp <= 0) {
		return false;
	}
	return true;
}

/**
 * 换面具：把玩家当前的结城理武将牌就地换成 newName。
 *
 * changeCharacter 只负责武将牌 / 技能 / 性别 / 势力，体力、体力上限、护甲一概不管，
 * 必须自己补。lib.character[name][2] 支持 "1" / "1/1" / "1/1/0"
 * （依次为 体力 / 体力上限 / 护甲）的字符串写法，要交给
 * get.infoHp / get.infoMaxHp / get.infoHujia 解析 —— 直接读 info.maxHp 会拿到 undefined。
 * 手牌、装备、判定区 changeCharacter 完全不碰，所以「牌不变」不需要额外保护逻辑。
 *
 * withSfx：是否播「切换为面具」那条音效。
 *   死亡换牌（①→②、②→③）要播；由 ②③ 在自己回合开始变回 ① 时不播
 *   （那种「天亮了变回初始面具」属于常态回归，不需要音效强调）。
 */
async function jyclSwapMask(player, newName, withSfx = true) {
	const info = lib.character[newName];
	if (!info) {
		return;
	}
	const newPair = [];
	for (const name of [player.name1, player.name2]) {
		if (!name) {
			continue;
		}
		newPair.push(JYCL_MASKS.includes(name) ? newName : name);
	}
	// 当前身上没有结城理的面具牌就不该换
	if (!newPair.includes(newName)) {
		return;
	}
	// 语音按主技能名找文件，所以必须在 changeCharacter 把旧技能摘掉之前播
	const mainSkill = JYCL_MAIN_SKILL[newName];
	if (mainSkill) {
		game.trySkillAudio(mainSkill, player, true);
	}
	// 面具切换的专用音效（素材：结城理/切换为面具）
	if (withSfx) {
		playSfx("切换为面具");
	}
	await player.changeCharacter(newPair);
	const hpData = info[2];
	player.maxHp = get.infoMaxHp(hpData);
	player.hujia = get.infoHujia(hpData);
	player.hp = get.infoHp(hpData); // 回满（三张面具上限都是 1）
	player.update();
	await jyclMaskGain(player, newName);
}

/**
 * 「获得该技能时」的效果：
 *   面具② — 抽一张牌，视为使用一张无距离限制且不计入次数限制的【杀】
 *   面具③ — 抽一张牌
 *   面具① — 无
 */
async function jyclMaskGain(player, newName) {
	if (newName == "jycl_makoto2") {
		await player.draw();
		const sha = game.createCard("sha");
		// chooseUseTarget 的字符串/布尔参数解析见 player.js：
		//   true -> forced（必须选目标，不再二次确认）、"nodistance" -> 无距离限制、
		//   false -> addCount = false（不计入次数限制）
		// 没有合法目标时不要硬弹框（canUse 传 distance=false、addCount=null 即忽略距离与次数）
		if (game.hasPlayer(target => target != player && player.canUse(sha, target, false, null))) {
			await player.chooseUseTarget(sha, true, "nodistance", false);
		}
	} else if (newName == "jycl_makoto3") {
		await player.draw();
	}
}

/**
 * 「死亡时更改武将牌」的公共实现（①→②、②→③ 都走这里）。
 *
 * 时机必须是 dieBefore，不能是 die：挂在 die 上时技能要到 die 事件 content 的第 3 个 step
 * 才被触发，而那时「判死」的动作早已做完 —— 第①步把人移进 game.dead 并把体力归零、
 * 第④步弃光手牌、第⑥步还会无条件给 game.me 挂上死亡界面（那一步只看 reserveOut、
 * 不看人死没死），所以即便在 die 里复活成功，看上去也还是「直接死了」。
 * dieBefore 由 gameEvent.js 的 loop() 在 content 之前触发且是 await 的，
 * 这里 cancel() 之后整段 content 一个 step 都不会执行（详细机制见说明.md）。
 */
function jyclDieMask(fromName, toName) {
	return {
		audio: false, // 语音由 jyclSwapMask 手动播主技能的
		// charlotte = 内部技能，不出现在武将牌的技能栏里。
		// 三张面具的描述上都只有「面具」一个技能，换牌时机靠这个藏起来。
		charlotte: true,
		trigger: { player: "dieBefore" },
		// 不弹确认框直接结算；direct / priority 对着官方十常侍【殁亡】配
		forced: true,
		forceDie: true,
		direct: true,
		priority: 15,
		filter(event, player) {
			return player.name1 == fromName || player.name2 == fromName;
		},
		async content(event, trigger, player) {
			// 拦掉整段死亡流程：不移入 game.dead、不隐藏界面、不弃手牌、不挂死亡按钮
			trigger.cancel();
			// cancel() 之后没人再把体力从 0 拉回来，得自己复活（同步函数且幂等）
			player.revive(1, false);
			await jyclSwapMask(player, toName);
		},
	};
}

/** 「回合开始时更换武将牌」的公共实现：②/③ 都换回面具① */
function jyclBeginMask(fromName) {
	return {
		audio: false,
		// 同上：内部技能，不显示在技能栏
		charlotte: true,
		// phaseBegin 在阶段的循环开始之前触发（content.js 的 phase steps），即「回合开始时」
		trigger: { player: "phaseBegin" },
		forced: true,
		direct: true,
		filter(event, player) {
			return player.name1 == fromName || player.name2 == fromName;
		},
		async content(event, trigger, player) {
			// 回合开始变回面具①：只播技能台词，不播「切换为面具」音效
			await jyclSwapMask(player, "jycl_makoto1", false);
		},
	};
}

/**
 * 明日方舟武将包的技能表
 *
 * 技能名（下面每个对象的键）默认同时是翻译键，所以 translate.js 里必须补上两项：
 *   lib.translate[技能名]      -> 技能显示名
 *   lib.translate[技能名_info] -> 技能描述
 *
 * 技能的基本分类：
 *   触发技   trigger + filter + content        满足时机时自动询问/发动
 *   主动技   enable + filterCard/filterTarget + content   玩家主动点按钮发动
 *   视为技   enable + viewAs + filterCard      把某些牌当成另一张牌使用
 *   规则修改 mod                               持续生效，没有 trigger/content
 *
 * content 统一用 async 写法：await 表示「等这个操作结算完毕再往下执行」，
 * 参数固定为 (event, trigger, player)：
 *   event   = 本次技能事件（选中的目标在 event.targets，选中的牌在 event.cards）
 *   trigger = 被监听的原始事件（只有触发技才有）
 *   player  = 技能拥有者
 *
 * @type { importCharacterConfig['skill'] }
 */
// ══════════════════════════════════════════════════════════════
// 「与牌堆换牌」这套能力的辅助函数
//
// ★ 必须放在 skills 对象**外面**：函数声明不能出现在对象字面量里，
//   而技能表会被 noname 的沙箱以严格模式求值，写在里面会直接语法错
//   （Unexpected identifier）。
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// 与牌堆换牌（普瑞赛斯武将牌② 在用）
//
// 两件事合在一个技能名下（靠 group + subSkill，与结城理的「面具」同一套写法）：
//   · 抽牌前换牌（锁定）：其他角色抽牌前把牌堆顶的「有价值的牌」换成随机牌
//   · 换牌（主动）：需要使用/打出牌时、或出牌阶段，拿一张手牌与牌堆里的一张牌互换
// 两者都**完全隐形**：不进技能栏（charlotte）、不播技能音效 / 不写战报 /
// 不播技能特效（direct）。主动那部分会弹选牌界面，但界面本身不暴露技能名。
//
// ★ 牌堆的真实结构（两段效果共同的地基）：
//     ui.cardPile 是一个 DOM 节点，**第一个子节点就是牌堆顶**。
//     get.cards(n) 的做法就是反复 ui.cardPile.removeChild(ui.cardPile.firstChild)，
//     所以「改牌堆顶」= 改这个节点的前几个子节点，不需要碰任何全局数组。
//     get.position(牌堆里的牌) 返回 "c"（get/index.js 里 card.destiny.id == "cardPile"）。
// ══════════════════════════════════════════════════════════════

/**
 * 「有价值」的判定 —— 各处换牌共用同一套标准。
 *
 *   装备牌 / 锦囊牌 / 桃 / 酒   → 有价值
 *   杀                         → 体力高于一半时才有价值
 *   闪                         → 体力不高于一半时才有价值
 *
 * 「高于一半」用 hp * 2 > maxHp 判断，等价于 hp > maxHp / 2，且整数运算没有浮点误差：
 * 3 体力 2 血 → 4 > 3 成立（高于一半）；3 体力 1 血 → 2 > 3 不成立。
 *
 * card 可以是实体牌（取 .name）也可以是牌名。
 */
function pileCardIsValuable(card, drawer) {
	const name = typeof card == "string" ? card : card && card.name;
	if (!name) {
		return false;
	}
	const type = get.type(name);
	if (type == "equip" || type == "trick") {
		return true;
	}
	if (name == "tao" || name == "jiu") {
		return true;
	}
	// 杀 / 闪 的价值取决于持有者的体力比例
	if (name == "sha" || name == "shan") {
		const hp = drawer && typeof drawer.hp == "number" ? drawer.hp : 1;
		const maxHp = drawer && typeof drawer.maxHp == "number" && drawer.maxHp > 0 ? drawer.maxHp : 1;
		const aboveHalf = hp * 2 > maxHp;
		return name == "sha" ? aboveHalf : !aboveHalf;
	}
	return false;
}

/**
 * 把「牌堆里实际存在的牌」按牌名聚合成选牌界面要的列表。
 *
 * 只扫 ui.cardPile：换牌就是从**牌堆**里取牌（没有弃牌堆这回事），
 * 抽牌前换牌与主动换牌用的是同一份实现。
 *
 * ★ 返回的 cards 里放的是**牌堆里的真实牌节点本身**，不是 {name, link} 包装对象。
 *   这一点是踩了实机崩溃才明白的：ui.create.buttonPresets.card 第一件事就是
 *       node = item.copy ? item.copy(false) : item.cloneNode(true)
 *   包装对象没有 cloneNode，于是直接抛
 *       TypeError: item.cloneNode is not a function
 *   （就是玩家截图里那个报错）。所以 name 要从节点自身的 .name 读，
 *   「还剩几张」另外用一张 Map 记，由调用方写进 gaintag 角标。
 *
 * 排序：有价值的排前面，其次按剩余张数，最后按牌名 —— 顺序稳定，好找。
 */
function pileCardNodes(drawer) {
	const map = new Map();
	for (const card of Array.from(ui.cardPile.childNodes)) {
		if (!card || !card.name) {
			continue;
		}
		if (!map.has(card.name)) {
			map.set(card.name, { card, count: 0 });
		}
		map.get(card.name).count++;
	}
	const groups = Array.from(map.values());
	groups.sort((a, b) => {
		const va = pileCardIsValuable(a.card.name, drawer) ? 1 : 0;
		const vb = pileCardIsValuable(b.card.name, drawer) ? 1 : 0;
		if (va != vb) {
			return vb - va;
		}
		if (a.count != b.count) {
			return b.count - a.count;
		}
		return String(get.translation(a.card.name)).localeCompare(String(get.translation(b.card.name)), "zh");
	});
	return {
		// 直接交给 ui.create.dialog 的卡牌节点数组
		cards: groups.map(g => g.card),
		// 节点 → 剩余张数，用来写角标
		counts: new Map(groups.map(g => [g.card, g.count])),
	};
}

/**
 * 「换牌」两段时序共用的前置检查。
 *
 * 只做**必要条件**判断，不加"每回合几次"之类的人为限制 —— 作者要的是
 * 「主动开启」，那就让他在需要用时随时能用；限制次数反而会挡住正常操作。
 */
function pileSwapReady(player) {
	if (!player || !ui.cardPile) {
		return false;
	}
	// 要换得出去、也要换得进来
	if (!player.countCards("h")) {
		return false;
	}
	if (!ui.cardPile.childNodes.length) {
		return false;
	}
	return true;
}

/**
 * 「换牌」的实际结算逻辑（两个技能各两个时机，一共四处共用）。
 * **不要直接当 content 用** —— 各处要各自防重入，见下面的包装函数。
 *
 * 流程：选一张手牌 → 选一张牌堆里的牌（按牌名聚合、标出剩余张数）→ 互换。
 * 写成函数声明是为了让它在下面 skills 对象字面量求值时就已存在 ——
 * 各处 `content:` 引用的包装函数会立刻调它。
 *
 * ★ 界面文案里**不带技能名**：普瑞赛斯的技能名是空白，
 *   共用同一句话才不会漏出内部技能名。
 *
 * 全程只搬 DOM，不产生 useCard / gain 动画，也不写日志：
 * 技能本身（charlotte + log:false）在界面与战报里都不会露面。
 */
async function pileSwapContent(event, trigger, player) {
	// ① 选一张要换出去的手牌。
	//    ★ 这里**不能**传 forced: true —— forced 会让引擎自动选牌
	//      （content.js 的 directFilter 分支），界面就永远不弹了。
	const handResult = await player.chooseCard("选择一张手牌换入牌堆", "h").forResult();
	if (!handResult.bool || !handResult.cards || !handResult.cards.length) {
		return;
	}
	const giveCard = handResult.cards[0];

	// ② 选要从牌堆拿的牌。
	//    界面借用无名杀标准的 chooseButton + 卡牌按钮（与杜预/张让那套同源）：
	//    ui.create.dialog(..., [list, "card"], "hidden") 的第三个参数 zoom 由
	//    dialog.add 转成 smallzoom 类，于是卡片变小、一屏能排下很多张。
	//    ★ list 里必须是**真实的牌节点**，见 pileCardNodes 的注释（否则 cloneNode 报错）。
	const pile = pileCardNodes(player);
	const dialog = ui.create.dialog(
		"选择一张牌堆里的牌换入手中（角标为牌堆剩余张数）",
		[pile.cards, "card"],
		"hidden"
	);
	dialog.classList.add("scroll1");
	dialog.content.style.maxHeight = "min(70vh, 620px)";
	dialog.content.style.overflowY = "auto";
	dialog.forcebutton = false;
	// 「每张牌还剩几张」写进卡片自带的 gaintag 角标 —— 那是卡牌本身的 DOM 元素
	//（card.js 的 node.gaintag），不额外加节点、也不会被卡面 CSS 裁掉。
	dialog.buttons.forEach(button => {
		const count = pile.counts.get(button.link);
		if (count && button.node && button.node.gaintag) {
			button.node.gaintag.innerHTML = count + "张";
		}
	});
	const result = await player
		.chooseButton(dialog)
		.set("filterButton", button => !!button.link)
		// AI 优先拿「有价值」的；真人看到的界面与这个无关
		.set("ai", button => (pileCardIsValuable(button.link, player) ? 10 : 1))
		.forResult();
	if (!result.bool || !result.links || !result.links.length) {
		return;
	}
	const taken = result.links[0];

	// ③ 互换。
	//    牌堆 → 手牌：直接搬 DOM。不用 gain()，避免摸牌动画
	//    （作者要求"不显示技能发动"，连摸牌的视觉也一并省掉）。
	ui.cardPile.removeChild(taken);
	taken.fix();
	player.directgain([taken]);
	//    手牌 → 牌堆：discard(false) = 洗回牌堆的随机位置
	giveCard.discard(false);
}


// ══════════════════════════════════════════════════════════════════
// 逻各斯 · 女妖之主 —— 【提喻】黑色效果的「封印手牌」
//
// 「随机一张未受此技能影响的手牌不能被使用、打出或弃置」这句里有三个坑：
//
// ① **怎么认定「某一张具体的手牌」**：官方（如公孙渊【怀异】的 gongsun_shadow、
//    谋诸葛瞻的 mbzhuguan）用的是 **gaintag** —— 牌自己的标记，存在 card.gaintag 里，
//    同时会渲染到牌面上（card.js 的 addGaintag 会把 get.translation(tag) 写进
//    node.gaintag）。这里直接拿内嵌技能名当 tag，translate 里译成一个「封」字，
//    玩家一眼就能看到哪张牌被封了。「未受此技能影响的手牌」＝还没有这个 tag 的牌。
//
// ② **mod 提供者必须是「全局技能」**：cardEnabled2 / cardDiscardable /
//    canBeDiscarded 这些过滤器最后都会走
//        game.checkMod(card, player, ..., <技能拥有者>)
//    而「技能拥有者」就是**正在用牌的那个人**（见 library/index.js 的 lib.filter）。
//    所以 mod **不能**挂在逻各斯身上 —— 那样别人用牌时根本不会去查他的技能。
//
//    第一版的做法是「命中时给目标 player.addSkill('lgs_tiyu_seal')」，
//    游戏里没生效。现在改成：lgs_tiyu_seal 作为**全局技能**，在扩展加载时用
//    game.addGlobalSkill 注册一次（见 main/content.js）。因为
//        checkMod → player.getModableSkills() → getSkills().concat(lib.skill.global)
//    全局技能会出现在**每个人**的 mod 候选列表里，于是不用给谁 addSkill，
//    那张牌落到谁手上都封得住。少一次 addSkill / removeSkill 的往返，
//    也就少一处会出错的地方。
//
// ③ **什么时候解除**：描述是「直到**你**（逻各斯）的下个结束阶段」，
//    不是「目标的下个结束阶段」，所以不能用 addTempSkill（它的失效时机是
//    技能持有者自己的阶段）。改成在逻各斯身上挂一个阶段触发技去统一清理。
//    由于 mod 是常驻的全局技能，解除 = 把牌上的 gaintag 清掉，仅此而已。
//
//    ⚠ 而且这里的「下个」是**下一个回合**，不是本回合：【提喻】是 phaseUse 技，
//      只能在逻各斯自己的出牌阶段发动，而本回合的 phaseJieshuBegin 紧接着就来。
//      按字面当成本回合的话，封印几秒内就被自己解掉（实机失败的直接原因）。
//
// ④ **每张牌各自计时**：不能整批共用一个到期时间 —— 连着两轮各封一张时，
//    先封的那张必须先在下一个结束阶段解开。per-card 的数据进不了 player.storage
//    （牌对象不能序列化），所以键用 cardid，并专门建一个隐藏技能
//    lgs_tiyu_sealmark 当这份数据的「命名槽」。详见 lgsClearSeal 的说明。
// ══════════════════════════════════════════════════════════════════
const LGS_SEAL = "lgs_tiyu_seal";

/**
 * 「封印计时」技能名 —— 一个**纯 storage 容器**的隐藏技能（没有 trigger / mod / enable）。
 *
 * 为什么要有个技能来装这份数据：封印是「每张牌各自计时」的，
 * 而技能是按玩家分的，`player.storage[技能名]` 正好是一个天然的命名槽。
 * 把 { "<cardid>": 到期轮数 } 挂在它下面，归属清楚，
 * 也不会和 lgs_tiyu 自己的 storage（距离修正）混在一起。
 */
const LGS_SEALMARK = "lgs_tiyu_sealmark";

/** 确保「封印计时」技能挂在 owner 身上，并返回它的 storage 槽（{ cardid: 到期轮数 }） */
function lgsEnsureSealmark(owner) {
	if (!owner.storage.lgs_tiyu_sealmark) {
		owner.storage.lgs_tiyu_sealmark = {};
	}
	if (!owner.hasSkill(LGS_SEALMARK)) {
		owner.addSkill(LGS_SEALMARK);
	}
	return owner.storage.lgs_tiyu_sealmark;
}

/** 【提喻】只认「有颜色」的牌：get.color 返回 "red" / "black" / "none"（无色牌无返回） */
function lgsIsRedOrBlack(card) {
	const color = get.color(card);
	return color == "red" || color == "black";
}

/**
 * 收集当前所有带「封」标记的牌：场上（含死亡角色的区域）+ 牌堆 + 弃牌堆 + 移出游戏区。
 *
 * 为什么要连牌堆 / 弃牌堆也扫：被封印的角色若在封印期间死亡，
 * 他的手牌会直接进弃牌堆 —— 那张牌已经不在任何人的 hejsx 区域里，
 * 只扫 game.players 够不着它，之后洗回牌堆就会带着残留标记到处跑，
 * 而全局 mod **认的就是这个标记**。
 */
function lgsCollectSealedCards() {
	const out = [];
	const push = list => {
		for (const card of list) {
			if (card && typeof card.hasGaintag === "function" && card.hasGaintag(LGS_SEAL)) {
				out.push(card);
			}
		}
	};
	for (const player of game.players.concat(game.dead || [])) {
		if (typeof player.getCards === "function") {
			push(player.getCards("hejsx"));
		}
	}
	for (const zone of [ui.cardPile, ui.discardPile, ui.special]) {
		if (zone && zone.childNodes) {
			push(Array.from(zone.childNodes));
		}
	}
	return out;
}

/**
 * 结算封印：把**已经到期**的那些牌的「封」标记清掉。
 *
 * ★ 每张牌**各自**记一个到期轮数，不是整批一个。
 *   数据放在 owner.storage.lgs_tiyu_sealmark 里，形式是 { "<cardid>": 到期轮数 }：
 *
 *   · 为什么用 cardid 当键：牌对象进不了 storage（联机要序列化），
 *     而 cardid 是引擎专门为联机准备的身份 —— card.js 的 init() 里
 *         if (_status.connectMode && !game.online && lib.cardOL && !this.cardid) {
 *             this.cardid = get.id();
 *             lib.cardOL[this.cardid] = this;
 *         }
 *     牌会按 cardid 注册进 lib.cardOL，各端一致，所以它能安全地跨端引用一张牌。
 *     键统一转成字符串，免得 Object.keys 回来是字符串、比较时数字字符串打架。
 *
 *   · 为什么能"各清各的"：due 只挑出**已到期**的 cardid，再交给 broadcastAll
 *     在各端按 cardid 匹配各自的牌去清 —— 各端算法一致，结果必然一致。
 *     （官方 player.removeGaintag 也是这个套路：broadcastAll + 传牌/标识过去。）
 *
 *   · 收尾要把两种 key 从 map 里删掉：已经清掉的，以及**牌已经找不到的**
 *     （被销毁 / 移出游戏）。不然 map 会一直非空，清理技每回合都白跑一遍全量扫描。
 */
function lgsClearSeal(owner) {
	const map = owner.storage.lgs_tiyu_sealmark;
	if (!map) {
		return;
	}
	const round = game.roundNumber;
	const seen = new Set();
	const due = [];
	for (const card of lgsCollectSealedCards()) {
		if (card.cardid === undefined || card.cardid === null) {
			continue;
		}
		const key = String(card.cardid);
		seen.add(key);
		if (typeof map[key] == "number" && round >= map[key]) {
			due.push(key);
		}
	}
	if (due.length) {
		// tag 和 id 列表都当参数传：这个函数体要序列化发到其他客户端，
		// 引用模块作用域的常量（LGS_SEAL）在单机看不出问题，联机会直接失效。
		game.broadcastAll(function (tag, ids) {
			const wipe = card => {
				if (card && typeof card.hasGaintag === "function" && card.hasGaintag(tag) && ids.includes(String(card.cardid))) {
					card.removeGaintag(tag);
				}
			};
			for (const player of game.players.concat(game.dead || [])) {
				if (typeof player.getCards === "function") {
					player.getCards("hejsx").forEach(wipe);
				}
			}
			for (const zone of [ui.cardPile, ui.discardPile, ui.special]) {
				if (zone && zone.childNodes) {
					Array.from(zone.childNodes).forEach(wipe);
				}
			}
		}, LGS_SEAL, due);
	}
	const dueSet = new Set(due);
	for (const key of Object.keys(map)) {
		if (dueSet.has(key) || !seen.has(key)) {
			delete map[key];
		}
	}
}

// ══════════════════════════════════════════════════════════════
// 普瑞赛斯 · 语言学家 —— 两张武将牌的公共逻辑
//
// 与结城理同一套「一个武将多张同名武将牌」的骨架：
//   武将牌① 可选；武将牌② 只在①死亡时被换上来，由 main/precontent.js 挡掉选将。
// 两张牌显示名都是「普瑞赛斯」、称号都是「语言学家」，
// 描述上都只显示**一个**技能，而且那个技能的标题与描述都留空（见 translate.js）。
// ══════════════════════════════════════════════════════════════

/** 普瑞赛斯的两张武将牌，顺序即换牌顺序 */
const PRSS_CARDS = ["prss_priestess1", "prss_priestess2"];

/** 武将牌① 主技能名（「每轮限一次」的历史记录按它查） */
const PRSS_SKILL1 = "prss_gaixie";

/**
 * 换武将牌：把玩家身上的普瑞赛斯牌就地换成 newName。
 *
 * 与 jyclSwapMask 同源 —— changeCharacter 只负责武将牌 / 技能 / 性别 / 势力，
 * 体力上限与护甲必须自己按新牌的 lib.character[name][2] 重新解析
 * （"3" / "3/3" / "3/3/0" 三种写法都要交给 get.infoMaxHp / get.infoHujia，
 *   直接读 info.maxHp 会拿到 undefined）。
 * 手牌、装备、判定区 changeCharacter 完全不碰，所以「牌不变」不需要额外保护逻辑。
 *
 * ★ 体力**不**回满。结城理三张面具上限都是 1，那边写 player.hp = get.infoHp(...)
 *   看不出差别；普瑞赛斯上限是 3，照抄就会变成「满血复活」。觉醒在这里只是
 *   「换个身份活下来」，体力保留 dieBefore 里 revive 出来的那 1 点。
 */
async function prssSwapCard(player, newName) {
	const info = lib.character[newName];
	if (!info) {
		return;
	}
	const newPair = [];
	for (const name of [player.name1, player.name2]) {
		if (!name) {
			continue;
		}
		newPair.push(PRSS_CARDS.includes(name) ? newName : name);
	}
	// 身上没有普瑞赛斯的牌就不该换
	if (!newPair.includes(newName)) {
		return;
	}
	await player.changeCharacter(newPair);
	const hpData = info[2];
	player.maxHp = get.infoMaxHp(hpData);
	player.hujia = get.infoHujia(hpData);
	if (player.hp > player.maxHp) {
		player.hp = player.maxHp;
	}
	player.update();
}

/**
 * 「抽牌前把牌堆顶的某些牌洗回牌堆」的公共实现。
 *
 * 牌堆是 ui.cardPile 这个 DOM 节点，**第一个子节点就是牌堆顶**，
 * 所以「读取牌堆顶 N 张」= 取前 N 个子节点，不需要碰任何全局数组。
 *
 *   card.discard(false) 就是引擎里「把这张牌洗回牌堆」的实现（card.js）：
 *   fix() 清掉所有动画类，然后 insertBefore 到牌堆里一个**随机位置**。
 *   一次调用同时完成两件事：
 *     · 被选中的牌随机埋回牌堆深处（等价于"与牌堆中的随机牌替换"）
 *     · 牌堆顶那一格由原本位于那个随机位置的牌顶上
 *   浏览器对"已在树上"的节点做 insertBefore 会先把它从原位置摘走，
 *   所以这是移动、不是复制，牌堆总数不变；全程不产生事件、不写日志。
 *
 * rounds = 「重复替换至多几次」：每轮都重新读一次牌堆顶 ——
 * 上一轮换进来的新牌可能又符合条件，这才是「重复」有意义的原因。
 * predicate(card, drawer) 返回 true 的牌才会被换走，所以同一套循环
 * 既能「换走有价值的」也能「换走没价值的」。
 */
function prssSweepTop(drawer, num, rounds, predicate) {
	try {
		for (let round = 0; round < rounds; round++) {
			const top = Array.from(ui.cardPile.childNodes).slice(0, num);
			if (!top.length) {
				return;
			}
			const targets = top.filter(card => predicate(card, drawer));
			if (!targets.length) {
				// 顶上已经没有要换的牌了，收工
				return;
			}
			for (const card of targets) {
				card.discard(false);
			}
		}
	} catch (err) {
		// 换牌绝不能把抽牌流程搞崩 —— 出错就放行，让抽牌照常进行
		console.error("方舟：普瑞赛斯换牌出错，已跳过", err);
	}
}

/**
 * 「这个目标对这张牌合法吗」—— 改目标时用的判定。
 * 与官方 olsbwance（重定目标）的 filterTarget 同一套标准。
 */
function prssTargetEnabled(card, user, target) {
	return lib.filter.targetEnabled2(card, user, target) && lib.filter.targetInRange(card, user, target);
}

/**
 * 取回「这次技能是被哪个事件触发的」—— 也就是那个 useCardToPlayer。
 *
 * 官方 olsbwance 在自己的 filterTarget / filterOk / ai2 里写的是
 * `get.event().getTrigger()`，这里跟着用，但加了两层保险：
 *   · 形状检查 —— 万一 getTrigger() 给回来的是别的东西，
 *     没有 card / player / targets 就没法用来判目标，直接放弃；
 *   · 闭包兜底 —— cost 是 async 函数，它捕获的 trigger 变量是完好的。
 * 两条路都留着是因为两边各有失效的场景：联机时 chooseTarget 上的字段
 * 有可能被序列化（闭包会丢），而引擎内部的触发链万一改版，getTrigger 也可能不对。
 */
function prssTriggerOf(fallback) {
	try {
		const evt = get.event()?.getTrigger?.();
		if (evt && evt.card && evt.player && evt.targets) {
			return evt;
		}
	} catch (err) {
		// 拿不到就退回闭包，不打断结算
	}
	return fallback;
}

/**
 * 普瑞赛斯武将牌② 的「换牌」—— 与「抽牌前换牌」**完全同一套结算**
 * （pileSwapContent：从牌堆里选一张牌，与一张手牌互换），
 * 连界面文案都共用同一份；差别只有防重入标记的名字。
 *
 * 标记名刻意与另一处换牌分开：两个时机各打各的，
 * 万一同一个事件路径上两处都触发，不该互相挡住。
 */
async function prssSwapUseContent(event, trigger, player) {
	event.prss_swap_use = true;
	await pileSwapContent(event, trigger, player);
}
async function prssSwapPhaseContent(event, trigger, player) {
	event.prss_swap_phase = true;
	await pileSwapContent(event, trigger, player);
}

// ══════════════════════════════════════════════════════════════════
// 煌 · 好兄弟 / 好运煌 —— 同一套「越残越强」的血线体系
//
// 【链锯】是赌徒技能：摸两张，全是红牌就白得一张无距离火【杀】并再来一次；
// 一旦摸到黑牌就掉 1 点体力、本回合技能作废。
// 【除颤】+【过载】+【沸腾】/【爆裂】是同一套「越残越强」的血线体系：
//   体力 < 3 时视为拥有【沸腾】，< 2 时换成【爆裂】（摸牌 +1，且前两张黑牌补成红桃）；
//   每局各一次的【除颤】则在自己跌破 2 / 1 时把血钉回去，
//   并把这份保护一直维持到**下个回合结束**。
//
// ★【除颤】的「保持在X以上」有个引擎层面的坑：
//   changeHp 的 trigger 时机是在 `player.hp += num` **之后**才触发的
//   （见 library/element/content.js 的 changeHp），监听者已经改不动这一次的 num，
//   只能在事后把血补回来 —— 效果上等价，代价是这一次伤害的结算照常发生。
//
// 两个武将走的是同一份代码，唯一的差别在【链锯】：
//   煌      —— 纯赌局，抽到什么算什么；
//   好运煌  —— 每次抽牌前先把牌堆里两张**视为红色**的牌铺到牌堆顶
//              （见 huangStackRedTop），于是「赌」只剩下
//              「牌堆里还凑不凑得出两张红牌」这一种失手方式。
// 九个技能因此由同一个工厂按前缀生成两份，实现一个字都没有复制
// （同「普瑞赛斯两处换牌共用 pileSwapContent」）。
// ══════════════════════════════════════════════════════════════════

/**
 * 【好运】—— 把牌堆里两张「对这名角色而言视为红色」的牌移到牌堆顶。
 *
 * 与普瑞赛斯的 prssSweepTop 是**同一处下手**（都在抽牌之前动 ui.cardPile），
 * 但动作相反：那边是把顶上不要的牌洗回牌堆的随机位置、让别的牌浮上来；
 * 这边是直接把要的牌捞到最上面。两者都只挪 DOM 节点，不产生任何游戏事件。
 *
 * 牌堆是 ui.cardPile 这个 DOM 节点，**第一个子节点就是牌堆顶**
 * （见 get.cards：`ui.cardPile.removeChild(ui.cardPile.firstChild)`），
 * 所以「移到牌堆顶」= 把挑出来的节点 insertBefore 到 firstChild 之前。
 * 浏览器对「已在树上」的节点做 insertBefore 会先把它从原位置摘走，
 * 因此这是移动不是复制 —— 牌堆总数不变，也不会凭空多出一张牌。
 *
 * ★「视为红色」直接交给 `get.color(card, player)`，不要自己拼花色表：
 *   get.color → get.suit → game.checkMod(…, "suit", owner)，而**把 player 传进去**
 *   之后 `owner = player`（见 get/index.js 的 suit），这名角色的 mod.suit 才会生效：
 *     · 红桃 / 方块  天然是红色；
 *     · 黑桃        体力 <3 时被【沸腾】视为红桃，所以也算红色；
 *     · 梅花        只有【爆裂】的名单能把它变红，而那份名单里记的**一定**是
 *                   已经抽到手的牌（见 huang_baolie_gain 的 gainAfter），
 *                   牌堆里的牌 get.owner() 是 undefined、那份 mod 根本不命中。
 *   作者明确要求「不考虑爆裂的前两张视为红色」，而这一条正是引擎自然的结果，
 *   不需要额外写判断 —— 反过来自己拼花色表，倒会把【沸腾】那一档漏掉。
 *
 * need 是「希望牌堆顶有几张红色的」；牌堆顶已经有几张贴合的就少补几张，
 * 找不到那么多就只补找得到的（「若可能」）。
 */
function huangStackRedTop(player, need) {
	try {
		const pile = ui.cardPile;
		if (!pile || need <= 0 || !pile.hasChildNodes()) {
			return;
		}
		const nodes = Array.from(pile.childNodes);
		const isRed = card => get.color(card, player) == "red";
		// 顶上前 need 张里已经是红色的不动，只补差额
		const lack = need - nodes.slice(0, need).filter(isRed).length;
		if (lack <= 0) {
			return;
		}
		// 从顶上那几张之后开始找，免得把刚数过的那几张又挑一遍
		const picked = [];
		for (let i = need; i < nodes.length && picked.length < lack; i++) {
			if (isRed(nodes[i])) {
				picked.push(nodes[i]);
			}
		}
		// 倒着插：insertBefore(card, firstChild) 每次都插到最前面，
		// 正着插会把挑出来的牌倒序；倒着插才保得住它们在牌堆里原有的先后顺序。
		for (let i = picked.length - 1; i >= 0; i--) {
			pile.insertBefore(picked[i], pile.firstChild);
		}
	} catch (err) {
		// 铺牌堆顶绝不能把抽牌流程搞崩 —— 出错就放行，让链锯照常抽
		console.error("方舟：好运煌铺牌堆顶出错，已跳过", err);
	}
}

/**
 * 按前缀生成煌那一套九个技能。
 *
 * 前缀同时决定**技能名**与**storage 的键**：煌和好运煌有可能同在一局里，
 * 共用键会让两个人的血线账本（除颤的保护下限、爆裂记了哪几张牌）互相覆盖。
 *
 * lucky = true 的那一份是「好运煌」：它只改【链锯】一处 ——
 *   content 里每轮抽牌前先 huangStackRedTop（把牌堆顶铺成两张视为红色的牌）。
 *   （原来它还比煌少一道「血少就别赌」的 AI 闸门；那道闸门现在已经整个撤了，
 *     见下面 filter 的注释。）
 */
function huangSkillSet(prefix, options = {}) {
	const lucky = !!options.lucky;
	// 技能名
	const S = {
		lianju: `${prefix}_lianju`,
		chuchan: `${prefix}_chuchan`,
		chuchanGuard: `${prefix}_chuchan_guard`,
		chuchanTick: `${prefix}_chuchan_tick`,
		guozai: `${prefix}_guozai`,
		feiteng: `${prefix}_feiteng`,
		baolie: `${prefix}_baolie`,
		baolieReset: `${prefix}_baolie_reset`,
		baolieGain: `${prefix}_baolie_gain`,
	};
	// storage 的键（理由见函数开头的注释）
	const K = {
		used1: `${prefix}_chuchan_used1`,
		used2: `${prefix}_chuchan_used2`,
		guardLimit: `${prefix}_chuchan_guard_limit`,
		pending: `${prefix}_chuchan_pending`,
		expiring: `${prefix}_chuchan_expiring`,
		guozaiNow: `${prefix}_guozai_now`,
		baolieCards: `${prefix}_baolie_cards`,
		baolieLeft: `${prefix}_baolie_left`,
	};

	return {
		// ── 链锯 ─────────────────────────────────────────────────
		// 描述：出牌阶段限一次，你可以指定一名其他角色并抽两张牌：
		//       若均为红色牌，你将这两张牌当做一张无距离限制的火【杀】对其使用，
		//       然后重复此效果；否则你失去1点体力。
		//       （好运煌多一句：你以此法抽牌前，将牌堆中两张视为红色的牌移至牌堆顶。）
		[S.lianju]: {
			// 八条语音（作战中1~4 / 选中干员1~2 / 部署1~2），发动时随机一条
			audio: "ext:方舟/skill:8",
			enable: "phaseUse",
			// 每回合限一次。★ 这里是**引擎原生**的次数限制（usable 的真实语义就是
			// 「每回合限 N 次」，见 player.js 的 getStat），不依赖任何自定义标记，
			// 也就不需要再挂一个时机去清理它。
			usable: 1,
			selectTarget: 1,
			filter(event, player) {
				// ★ 这里**没有**血量门槛（作者要求）。煌的收益结构是反过来的：
				//   血越少越该赌 ——【沸腾】在 3 血以下把黑桃视为红桃，
				//   【爆裂】在 2 血以下再把前两张黑牌也补成红桃，
				//   也就是说血越少，「抽到两张红牌」的成功率越高，
				//   而成功那一发是白赚一张无距离的火【杀】。
				//   （早先这里有一道「hp <= 2 就不发动」的 AI 闸门，
				//     正好把煌最该出手的时机整个挡在外面，已撤。）
				return game.hasPlayer(current => current != player && current.isAlive());
			},
			filterTarget: lib.filter.notMe,
			async content(event, trigger, player) {
				const target = event.targets[0];
				// 「若均为红色牌……并重复该效果」＝把「抽两张 → 判断 → 打杀」整段重跑一遍。
				// 这个循环是**同一次发动内**的多轮结算，不再额外消耗 usable 的次数。
				// 摸到黑牌就会停，循环必然终止；这个上限只是防
				// 「洗牌之后恰好一直摸到红牌」这种极端情况把游戏卡住。
				for (let i = 0; i < 12; i++) {
					if (!player.isAlive() || !target.isAlive()) {
						return;
					}
					// 好运煌：先铺牌堆顶再抽。★ 必须在 get.cards 之前 ——
					// 那一步会把牌堆顶的两张直接摘走，之后再换就来不及了。
					if (lucky) {
						huangStackRedTop(player, 2);
					}
					const cards = get.cards(2);
					await player.gain(cards, "draw");
					if (cards.length == 2 && cards.every(card => get.color(card, player) == "red")) {
						// 「将其当做1张无距离限制的火【杀】对其使用」
						// ★ 第二个参数**必须**把这两张实体牌一起传进去。
						//   player.useCard 是按「参数的类型」认牌的（见 player.js 的 useCard）：
						//   VCard 实例的 itemtype 是 "vcard" 而不是 "card"，
						//   只传它的话 next.cards 会落成**空数组** —— 这两张牌根本没被用出去，
						//   看起来就像凭空生成了一张虚拟【杀】。
						//   官方对这种情况一律这么写：
						//       useCard(get.autoViewAs(viewAs, cards), cards, targets)
						await player.useCard(get.autoViewAs({ name: "sha", nature: "fire" }, cards), cards, target).set("nodistance", true);
						continue;
					}
					// 两张里有黑牌：失去 1 点体力，这次发动到此为止
					await player.loseHp(1);
					return;
				}
			},
			ai: {
				// 每回合只有一次机会，所以基础优先级本来就给得偏高。
				// ★ 而且它跟着体力走、还是**反着**走的：血越少越先出 ——
				//   【沸腾】在 3 血以下把黑桃视为红桃、【爆裂】在 2 血以下再补
				//   两张黑牌，等于血越少成功率越高；失手掉的那 1 点体力，
				//   在血少时也更容易被【除颤】兜回来。
				order(skill, player) {
					// ★ 这个函数有可能会被**不传 player** 地调用：
					//   content.js 濒死求桃那段的 ai1 就是裸的 `info.ai.order()`，
					//   官方【强化】的 order 为此写着一模一样的兜底。
					//   少了这一手，player.hp 会直接抛 TypeError。
					if (!player) {
						player = _status.event.player || game.me;
					}
					if (!player) {
						return 6;
					}
					if (player.hp <= 1) {
						return 9;
					}
					if (player.hp <= 2) {
						return 8;
					}
					return 6;
				},
				result: {
					// ★★ 这里是**目标视角**的损益（正 = 对目标有益），不是施术者视角，
					//    所以千万不能写 -get.attitude(player, target)！
					//
					//    这个返回值还会被 get.effect_use 再乘一次
					//    get.attitude(player, target)，才换算成施术者视角 ——
					//    见 get/index.js 的收尾：
					//        final = result1 * attitude(player, player)
					//              + result2 * attitude(player, target);
					//    链锯没写 result.player，result1 会被归一成 0，
					//    于是 final 只剩下 result2 * attitude(player, target)。
					//
					//    伤害类操作在这里必须是**负数**，同【杀】的
					//    ai.result.target（基础 eff = -1.5）。
					//    原来写的 -get.attitude 让 final = (-att) * att = -att²，
					//    对敌人 / 队友 / 中立**恒 ≤ 0**：ai.basic.chooseTarget 每次
					//    都撞在 `if (check(targets[ix]) <= 0) return ok;`（ok 为 false）
					//    上放弃选目标；失败后 content.js 把技能塞进 _aiexclude 并 redo，
					//    重来时 game.Check.skill 的
					//    `event.isMine() || !event._aiexclude.includes(i)` 又会把它滤掉，
					//    链锯从此回不到候选列表 —— **AI 整局都不会发动它**。
					//    （人类手点不走 AI 评分，所以只有 AI 中招。）
					//
					//    只给一个与【杀】同档的 -1.5：抽两张牌那一半的收益归上面的
					//    order 管，在 result 里表达不了。
					target() {
						return -1.5;
					},
				},
			},
		},

		// ── 除颤 ─────────────────────────────────────────────────
		[S.chuchan]: {
			audio: "ext:方舟/skill:8",
			locked: true,
			forced: true,
			trigger: { player: "changeHp" },
			filter(event, player) {
				// changeHp 的 trigger 时机在 `player.hp += num` 之后，这里读到的是新值
				if (event.num >= 0 || player.hp >= 2) {
					return false;
				}
				// 「每局游戏各限一次」：2 点档和 1 点档各算一次。
				// 优先用 2 点档 —— 它能救得更彻底。
				if (!player.storage[K.used2]) {
					return true;
				}
				return player.hp < 1 && !player.storage[K.used1];
			},
			async content(event, trigger, player) {
				const two = !player.storage[K.used2];
				const limit = two ? 2 : 1;
				player.storage[two ? K.used2 : K.used1] = true;
				game.log(player, "发动了", "【除颤】", `（保护至 ${limit} 点）`);
				// 先把血补回下限，再挂保护壳
				await player.recover(limit - player.hp);
				player.storage[K.guardLimit] = limit;
				player.storage[K.pending] = true;
				player.addSkill(S.chuchanGuard);
			},
			group: [S.chuchanTick],
			ai: { threaten: 1.4 },
		},
		// 除颤的保护壳：体力掉到下限以下就立刻补回来
		[S.chuchanGuard]: {
			audio: false,
			charlotte: true,
			locked: true,
			forced: true,
			silent: true,
			popup: false,
			sourceSkill: S.chuchan,
			mark: true,
			marktext: "除颤",
			intro: { name: "除颤", content: "你的体力值始终保持在「除颤」保护的下限以上。" },
			trigger: { player: "changeHp" },
			filter(event, player) {
				const limit = player.storage[K.guardLimit];
				return typeof limit == "number" && player.hp < limit;
			},
			async content(event, trigger, player) {
				await player.recover(player.storage[K.guardLimit] - player.hp);
			},
		},
		// 除颤的到期管理：pending → expiring 的两段式，
		// 「下个回合结束」为什么不能直接用 addTempSkill 的 expire，理由同【重力自定义】
		[S.chuchanTick]: {
			audio: false,
			charlotte: true,
			forced: true,
			silent: true,
			popup: false,
			sourceSkill: S.chuchan,
			// 「你的下个回合」到了：本回合结束时收回保护
			trigger: { player: ["phaseBegin", "phaseEnd"] },
			filter(event, player, name) {
				if (name == "phaseBegin") {
					return player.storage[K.pending] === true;
				}
				return player.storage[K.expiring] === true;
			},
			async content(event, trigger, player) {
				if (event.triggername == "phaseBegin") {
					player.storage[K.expiring] = true;
					delete player.storage[K.pending];
					return;
				}
				player.removeSkill(S.chuchanGuard);
				delete player.storage[K.expiring];
				delete player.storage[K.guardLimit];
			},
		},

		// ── 过载 ─────────────────────────────────────────────────
		// 描述：锁定技，你的体力值低于3/2时，你视为拥有【沸腾】/【爆裂】。
		// ★ 两档是**叠加**的：体力低于 2 时两个都在手，摸牌阶段会一次 +2。
		[S.guozai]: {
			audio: "ext:方舟/skill:8",
			locked: true,
			forced: true,
			trigger: { player: ["changeHp", "phaseBegin"] },
			filter(event, player) {
				// 只在「该拥有的技能换了」时才发动，免得每掉一次血都跳一次技能提示
				return (player.storage[K.guozaiNow] || "") != huangGuozaiKey(player);
			},
			async content(event, trigger, player) {
				const key = huangGuozaiKey(player);
				player.storage[K.guozaiNow] = key;
				const want = [];
				if (key.includes("f")) {
					want.push(S.feiteng);
				}
				if (key.includes("b")) {
					want.push(S.baolie);
				}
				for (const skill of [S.feiteng, S.baolie]) {
					if (!want.includes(skill)) {
						if (player.hasSkill(skill)) {
							player.removeSkill(skill);
						}
						continue;
					}
					if (player.hasSkill(skill)) {
						continue;
					}
					player.addSkill(skill);
					if (skill == S.baolie) {
						// 获得【爆裂】时把上一次记的名单作废（技能是重新拿到的），
						// 额度给满；「按出牌阶段重置」由 baolieReset 负责
						player.storage[K.baolieCards] = [];
						player.storage[K.baolieLeft] = 2;
					}
				}
			},
		},

		// 过载体力 <3 时「视为拥有」的技能
		[S.feiteng]: {
			audio: false,
			locked: true,
			forced: true,
			// 摸牌阶段的摸牌数+1。用 phaseDrawBegin2 而不是 drawBegin，
			// 是因为描述限定在「抽牌阶段」；numFixed 是引擎给「锁定摸牌数」留的口子。
			trigger: { player: "phaseDrawBegin2" },
			filter(event, player) {
				return !event.numFixed;
			},
			async content(event, trigger, player) {
				trigger.num += 1;
			},
			// 「你的黑桃牌始终视为红桃」：suit 这个 mod 只会在
			// get.suit(card, owner) 时被 owner 的技能表调到，正好是「你的牌」。
			// ★ 好运煌的 huangStackRedTop 也是靠它才知道「牌堆里哪些黑桃算红色」。
			mod: {
				suit(card, suit) {
					if (suit == "spade") {
						return "heart";
					}
				},
			},
		},
		// 过载体力 <2 时「视为拥有」的技能
		[S.baolie]: {
			audio: false,
			locked: true,
			forced: true,
			trigger: { player: "phaseDrawBegin2" },
			filter(event, player) {
				return !event.numFixed;
			},
			async content(event, trigger, player) {
				trigger.num += 1;
			},
			mod: {
				suit(card, suit) {
					// 这个 mod 只会被「拥有【爆裂】的人」的 checkMod 调到
					// （checkMod 遍历的是技能拥有者的技能表），
					// 所以直接看这张牌现在在谁那里，就知道该查谁的名单。
					// ★ 牌堆里的牌 get.owner() 是 undefined —— 名单里记的一定是
					//   已经抽到手的牌，所以这份 mod 对牌堆无效（作者要的正是这个）。
					const owner = get.owner(card);
					if (owner && Array.isArray(owner.storage[K.baolieCards]) && owner.storage[K.baolieCards].includes(card)) {
						return "heart";
					}
				},
			},
			group: [S.baolieGain, S.baolieReset],
			onremove(player, skill) {
				delete player.storage[skill];
				delete player.storage[K.baolieCards];
				delete player.storage[K.baolieLeft];
			},
		},
		// 【爆裂】的额度按「出牌阶段」算：每个出牌阶段开始时重新给满 2 张。
		//
		// ★ 名单（baolieCards）**不**在这里清 —— 「视为红桃」是持久的，
		//   只要那些牌还在手里就一直是红桃；这里只补额度。
		[S.baolieReset]: {
			audio: false,
			charlotte: true,
			forced: true,
			silent: true,
			popup: false,
			sourceSkill: S.baolie,
			trigger: { player: "phaseUseBegin" },
			async content(event, trigger, player) {
				player.storage[K.baolieLeft] = 2;
			},
		},
		// 「你于出牌阶段内抽到的前2张黑色牌视为红桃」：把摸到的黑牌记进名单，
		// 由上面的 mod 兑现
		[S.baolieGain]: {
			audio: false,
			charlotte: true,
			locked: true,
			forced: true,
			silent: true,
			popup: false,
			sourceSkill: S.baolie,
			trigger: { player: "gainAfter" },
			filter(event, player) {
				// 只认「抽（摸牌）」，别的获得方式不算
				if (!event.getParent("draw")) {
					return false;
				}
				// ★ 只数**出牌阶段**内抽到的牌 —— 摸牌阶段摸上来的那两张不算。
				//   用事件链判断（phaseUse.player 就是出牌阶段那位），
				//   比 _status.event 稳：filter 跑的时候 _status.event 是 arrangeTrigger。
				const phaseUse = event.getParent("phaseUse");
				if (!phaseUse || phaseUse.player != player) {
					return false;
				}
				return player.storage[K.baolieLeft] > 0;
			},
			async content(event, trigger, player) {
				let left = player.storage[K.baolieLeft];
				if (!Array.isArray(player.storage[K.baolieCards])) {
					player.storage[K.baolieCards] = [];
				}
				for (const card of trigger.cards || []) {
					if (left <= 0) {
						break;
					}
					if (get.color(card, player) != "black") {
						continue;
					}
					player.storage[K.baolieCards].push(card);
					left -= 1;
				}
				player.storage[K.baolieLeft] = left;
			},
		},
	};
}

// ══════════════════════════════════════════════════════════════════
//  塔露拉 · 不死的黑蛇（群 / 3体力）
// ══════════════════════════════════════════════════════════════════
//
// 【燎原】原文里的两组斜杠是**配对**的，不是四个自由组合：
//     你的回合 内 / 外   ——   当前回合角色对 其他角色 / 你 造成伤害时
// 也就是「你回合里别人挨打」和「别人回合里你挨打」两件事。发动之后，
// 「与受伤角色各摸1张牌」跟着前一件事走，「获得场上其区域内的1张牌」
// 跟着后一件事走。
//
// 【黑蛇】把这两组斜杠**一起颠倒**（内↔外，区域内外跟着换），顺带让
// 非限定技变成锁定技、限制次数 +1 —— 于是觉醒之后，「你自己对你自己的
// 伤害」（【安魂】）就成了【燎原】的燃料，整张卡是靠这个轴转起来的。

// 是否已觉醒（awakenSkill 会把 storage[技能名] 置真）
function tllAwake(player) {
	return !!player.storage.tll_heishe;
}

// 「每回合限X次」数的是**每个角色的回合**各一次，所以不能交给 usable ——
// 那个只在技能拥有者自己的回合开始时清零，别人的回合里根本数不着。
function tllLiaoyuanMax(player) {
	return tllAwake(player) ? 2 : 1;
}

function tllAnhunMax(player) {
	return tllAwake(player) ? 2 : 1;
}

// 【燎原】这一次该走「摸牌」还是「偷牌」那一支：
//   觉醒前 —— 回合内 → 其他角色挨打 → 摸牌；回合外 → 你挨打 → 偷牌
//   觉醒后 —— 颠倒
function tllStealBranch(player) {
	const inner = _status.currentPhase == player;
	return tllAwake(player) ? inner : !inner;
}

// 从牌堆里随机抽一张【杀】。
// 牌堆是 DOM（ui.cardPile 的子节点），get.cards() 只能从两头取，所以这里
// 自己遍历挑；挑定之后才 removeChild，免得边遍历边改动集合。
function tllDrawShaFromPile() {
	const list = [];
	for (const card of ui.cardPile.childNodes) {
		if (get.name(card) == "sha") {
			list.push(card);
		}
	}
	if (!list.length) {
		return null;
	}
	const card = list[Math.floor(Math.random() * list.length)];
	card.original = "c";
	ui.cardPile.removeChild(card);
	game.updateRoundNumber();
	return card;
}

// 觉醒之后换立绘。不走 lib.config.skin、也不额外注册一张武将牌 ——
// 直接改 DOM；技能的 content 在联机时每个客户端都会跑一遍，
// 各自换各自的，用不着广播。
function tllSwitchAwakeImage(player) {
	if (!player.node || !player.node.avatar) {
		return;
	}
	player.node.avatar.setBackgroundImage("extension/方舟/tll_talula_awake.png");
	if (player == game.me && ui.fakeme) {
		ui.fakeme.style.backgroundImage = player.node.avatar.style.backgroundImage;
	}
}

// 「获得场上其区域内的1张牌」：
//   「其」= 当前回合角色（也就是伤害来源）；
//   区域内 = 其自己区域里的牌；区域外 = 场上除其区域以外的牌
//   （原文的注释也是这么解释区域外的 ——「其他所有人区域中的牌」）。
// 觉醒前这一支只在「你回合外、你受伤」时走，所以「其」正是打你的那个人。
async function tllLiaoyuanSteal(player, holder) {
	const awake = tllAwake(player);
	const pool = [];
	if (awake) {
		for (const target of game.filterPlayer(current => current != holder && current.isIn())) {
			pool.addArray(target.getCards("hej"));
		}
	} else if (holder.isIn()) {
		pool.addArray(holder.getCards("hej"));
	}
	if (!pool.length) {
		return;
	}
	const prompt = awake
		? `燎原：获得场上${get.translation(holder)}区域外的一张牌`
		: `燎原：获得${get.translation(holder)}区域内的一张牌`;
	const result = await player.chooseButton([prompt, pool], true).forResult();
	if (result.bool && result.links.length) {
		const card = result.links[0];
		await player.gain(card, get.owner(card), "give");
	}
}

// ══════════════════════════════════════════════════════════════════
//  年 · 洪炉示岁（魏 / 4体力）
// ══════════════════════════════════════════════════════════════════
//
// 【洪炉】置入出去的装备会被打上 nian_from 标记，【锻器】整个技能就是围着
// 这个标记转：谁身上挂着你置入的武器/防具，谁出手的时候你都有话说。
//
// ★ 标记里存的是**置入者的 playerid**，不是玩家对象 —— 这份数据要跟着牌
//   在联机各端之间对账，纯字符串才靠得住。

function nianPlacedBy(card, player) {
	return !!card && !!card.storage && card.storage.nian_from == player.playerid;
}

// 目标装备区里由「你」置入的武器（槽 1）/ 防具（槽 2）
function nianPlacedWeapon(target, player) {
	const card = target.getEquip(1);
	return nianPlacedBy(card, player) ? card : null;
}

function nianPlacedArmor(target, player) {
	const card = target.getEquip(2);
	return nianPlacedBy(card, player) ? card : null;
}

function nianMarkPlaced(card, player) {
	if (card && card.storage) {
		card.storage.nian_from = player.playerid;
	}
}

// 【洪炉】三个选项里当下做得成的那些
function nianHongluOptions(player) {
	const list = [];
	if (player.countCards("e") && game.hasPlayer(current => current != player && current.isIn())) {
		list.push({ key: "选项一", text: "将你装备区的一张牌移动到其他角色的装备区（若其已有则替换之）" });
	}
	if (player.countCards("he") && get.discardPile(card => get.type(card) == "equip")) {
		list.push({ key: "选项二", text: "弃置一张牌，将弃牌区的一张装备牌置入一名角色的装备区" });
	}
	if (player.countCards("he") && get.cardPile2(card => get.type(card) == "equip")) {
		list.push({ key: "选项三", text: "弃置一张牌，从牌堆抽取一张装备牌" });
	}
	return list;
}

// 【锻器】两个分支都长着「选择一项」的样子：能选的摊开给玩家挑，
// 只剩一项可做的时候不弹窗、直接做。
async function nianDuanqiChoose(player, prompt, choices) {
	const list = choices.filter(choice => choice.ok);
	if (!list.length) {
		return null;
	}
	if (list.length == 1) {
		return list[0].key;
	}
	const result = await player
		.chooseControl(list.map(choice => choice.key))
		.set("prompt", prompt)
		.set("choiceList", list.map(choice => choice.text))
		.forResult();
	return result && result.control ? result.control : null;
}

// ── 「陈」的牌类型（basic / trick / equip）────────────────────────
// 用 get.type2 而不是 get.type：后者把延时锦囊单列成 "delay"，而作者口径里的
// 「牌类型」是基本 / 锦囊 / 装备三类（延时锦囊归入锦囊）。
const CHEN_TYPES = ["basic", "trick", "equip"];
const CHEN_TYPE_TEXT = { basic: "基本牌", trick: "锦囊牌", equip: "装备牌" };

/** 陈「拥有」的牌类型：手牌 + 装备区 + 判定区里实际出现过的类型 */
function chenOwnedTypes(player) {
	const owned = new Set();
	for (const card of player.getCards("hej")) {
		owned.add(get.type2(card));
	}
	return CHEN_TYPES.filter(type => owned.has(type));
}

/** 一次伤害涉及的两方（伤害来源 + 受伤角色），去重并剔掉已经不在场的 */
function chenDamageSides(event) {
	const list = [];
	for (const target of [event.source, event.player]) {
		if (target && target.isIn() && !list.includes(target)) {
			list.push(target);
		}
	}
	return list;
}

/**
 * 【绝影】该弃牌还是攒那 1 点伤害。
 *
 * 账不难算：弃**对手**的牌是收益，弃**自己**的牌是代价（伤害的两方都要弃，
 * 而自己常常正是其中一方）。净收益为正才值得弃，否则留着 +1 更划算。
 */
function chenJueyingPick(trigger, player) {
	const types = chenOwnedTypes(player);
	if (!types.length) {
		return "cancel2";
	}
	const sides = chenDamageSides(trigger);
	let best = "cancel2";
	let bestScore = 0;
	for (const type of types) {
		let score = 0;
		for (const side of sides) {
			const num = side.getCards("hej", card => get.type2(card) == type).length;
			score += side == player ? -num : num;
		}
		if (score > bestScore) {
			bestScore = score;
			best = CHEN_TYPE_TEXT[type];
		}
	}
	return best;
}

/** 记下「下次由牌造成的伤害+1」—— 不可叠加，所以至多 1 枚 */
function chenJueyingMark(player) {
	if (player.countMark("chen_jueying_buff") <= 0) {
		player.addMark("chen_jueying_buff", 1);
	}
}

/** 【拔刀】值不值得拿 1 点体力去换「此牌结算两次」 */
function chenBadaoWorth(trigger, player) {
	// 血少就别玩命：这 1 点伤害可能直接把自己打进濒死
	if (player.hp <= 2) {
		return false;
	}
	// 装备牌已经被 filter 挡在外面，这里只管体力门槛
	if (!trigger.card) {
		return false;
	}
	return true;
}

const skills = {
	// ══════════════════════════════════════════════════════════════
	// 维什戴尔 · 绝对主角（群 / 4体力）
	//
	// 三个技能是互相咬合的：
	//   【魂影】用“视为造成伤害”在本回合的伤害历史里给某个角色打上标记，
	//   【余震】检测到“本回合已对其造成过伤害”后追加一次伤害，
	//   【黎明】把余震的这次追加伤害从单体扩散成“目标及其距离1以内”的范围伤害。
	// ══════════════════════════════════════════════════════════════

	// ── 余震 ─────────────────────────────────────────────────────
	// 描述：锁定技，每回合限一次，当你对一名角色造成伤害后，
	//       若你于本回合内已对其造成过伤害，你对其造成X点伤害（X为此伤害值的一半，向上取整）。
	wsde_yuzhen: {
		// 技能语音：audio 写成 "ext:<扩展名>/skill:<条数>"，
		// get.Audio 会展开成 ext:方舟/skill/wsde_yuzhen1.mp3 … wsde_yuzhen3.mp3，
		// 播放时随机取一条（"ext:" 前缀由 game.playAudio 解析为 extension/ 目录）
		audio: "ext:方舟/skill:3",
		// damageSource：伤害结算结束后，以“伤害来源是自己”的身份触发
		// （event.player 是受伤角色，event.num 是本次伤害值）
		trigger: { source: "damageSource" },
		// 触发技的 usable 是按“回合”统计的（见 lib.filter.filterTrigger 里
		// player.getStat("triggerSkill")），所以 usable: 1 就等于“每回合限一次”
		usable: 1,
		// 锁定技：条件满足必定发动，不需要玩家确认
		forced: true,
		locked: true,
		filter(event, player) {
			const target = event.player;
			if (!target || !target.isIn() || event.num <= 0) {
				return false;
			}
			// 本回合造成的伤害记录在 sourceDamage 历史里；
			// 本次事件在历史里不是第一条 => 在此之前已经对其造成过伤害
			return player.getHistory("sourceDamage", evt => evt.player == target).indexOf(event) > 0;
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			// X = 此伤害值的一半，向上取整
			const num = Math.ceil(trigger.num / 2);
			// 由【黎明】的【杀】触发的余震：追加伤害改为对“该角色及距离其1以内的所有角色”生效
			if (isLimingShaSkill(trigger.getParent("useCard")?.skill)) {
				const targets = game.filterPlayer(current => current == target || get.distance(target, current) <= 1);
				for (const current of targets) {
					await current.damage(num, player);
				}
			} else {
				await target.damage(num, player);
			}
		},
	},

	// ── 魂影 ─────────────────────────────────────────────────────
	// 描述：锁定技，其他角色使用的单体锦囊牌不能指定你为目标。
	//       出牌阶段开始时，你可以视为对一名其他角色造成过1点伤害。
	//       当你受到伤害后，直到你的下个准备阶段，此技能失效。
	wsde_hunying: {
		// 同样随机播放 wsde_hunying1~3.mp3（素材里同样是“作战中1~3”）
		audio: "ext:方舟/skill:3",
		locked: true,
		mod: {
			targetEnabled(card, player, target) {
				// player 是使用者，target 是目标（也就是本技能拥有者）
				if (player == target) {
					return;
				}
				// 技能失效期间这段锁定技不生效（temp_ban 只自动拦截触发技，
				// mod 需要自己判断）
				if (target.isTempBanned("wsde_hunying")) {
					return;
				}
				const info = get.info(card);
				// 只拦锦囊牌。注意 get.type 会把延时锦囊单独归为 "delay"，
				// 用 get.type2 才能把普通锦囊与延时锦囊一起算成 "trick"
				if (!info || get.type2(card) != "trick") {
					return;
				}
				// “单体”= 只能指定一个目标（过河拆桥/顺手牵羊/决斗/火攻/乐不思蜀…）
				if (info.selectTarget != 1) {
					return;
				}
				// 返回 false = 不能以其为目标
				return false;
			},
		},
		// 出牌阶段开始时的效果
		trigger: { player: "phaseUseBegin" },
		filter(event, player) {
			return !player.isTempBanned("wsde_hunying") && game.hasPlayer(current => current != player && current.isIn());
		},
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget("魂影：视为对一名其他角色造成过1点伤害", lib.filter.notMe)
				.set("ai", target => -get.attitude(player, target))
				.forResult();
			if (!result.bool) {
				return;
			}
			const target = result.targets[0];
			// 记录发动次数，供【黎明】判断“已发动过至少两次”
			player.setStorage("wsde_hunying", (player.getStorage("wsde_hunying") || 0) + 1);
			player.line(target, "green");
			// unreal =「视为造成伤害」：会写进伤害历史（所以能和【余震】联动）、
			// 不实际扣体力、不进濒死；
			// ★ 但它**照样**会触发 damage / damageEnd / damageAfter / damageSource
			//   —— 只跳过 damageBegin1~4 与濒死判定（主体那一步的 `goto(6)` 后面
			//   没有 return，「受到伤害时」照跑），别照抄旧注释
			await target.damage({ num: 1, source: player, unreal: true });
		},
		// 受伤后令本技能失效
		group: ["wsde_hunying_off"],
		ai: {
			order: 1,
			result: {
				target(player, target) {
					return -get.attitude(player, target);
				},
			},
		},
	},
	wsde_hunying_off: {
		audio: false,
		trigger: { player: "damageEnd" },
		forced: true,
		locked: true,
		silent: true,
		popup: false,
		charlotte: true,
		sourceSkill: "wsde_hunying",
		filter(event, player) {
			return !player.isTempBanned("wsde_hunying");
		},
		async content(event, trigger, player) {
			// tempBanSkill：让技能“暂时失效”。
			// 第二参数 { player: "phaseBegin" } = 在自己的下个准备阶段开始时解除
			player.tempBanSkill("wsde_hunying", { player: "phaseBegin" });
		},
	},

	// ── 黎明 ─────────────────────────────────────────────────────
	// 描述：限定技，出牌阶段，若你已发动过至少两次【魂影】的出牌阶段效果，
	//       你可以将牌库顶六张牌置于你的武将牌上。
	//       你可以将武将牌上的这些牌如手牌般使用或打出，均视为【杀】，若如此做，你翻面。
	//       你以此法使用的【杀】造成的伤害+1；无法被响应；无距离限制；
	//       此【杀】触发【余震】时，额外伤害改为对距离该角色1以内的所有角色生效。
	wsde_liming: {
		// 发动限定技（觉醒）时播报 wsde_liming1.mp3（素材“行动开始”）
		audio: "ext:方舟/skill:1",
		enable: "phaseUse",
		limited: true,
		skillAnimation: true,
		animationColor: "orange",
		// 没有 filterCard / selectCard：这是不需要选牌的主动技，点一下就直接发动
		filter(event, player) {
			return (player.getStorage("wsde_hunying") || 0) >= 2;
		},
		async content(event, trigger, player) {
			// 限定技的固定写法：标记为已发动
			player.awakenSkill(event.name);
			// 取牌堆顶六张牌。get.cards 会把牌从牌堆移出（牌堆空了会自动洗牌），
			// 所以不需要自己处理牌堆耗尽的情况
			const cards = get.cards(6);
			// 置于武将牌上（扩展区）并打上 wsde_liming 标记，
			// 之后用 player.getExpansions("wsde_liming") 就能取回这些牌
			const next = player.addToExpansion(cards, "gain2");
			next.gaintag.add("wsde_liming");
			await next;
			// 启用“将武将牌上的牌当【杀】使用或打出”的能力
			player.addSkill("wsde_liming_sha");
		},
		ai: {
			order: 1,
			result: { player: 1 },
		},
		// 技能被移除（如被“断肠”一类效果）时，武将牌上的牌要有个去处
		onremove(player, skill) {
			const cards = player.getExpansions("wsde_liming");
			if (cards.length) {
				player.loseToDiscardpile(cards);
			}
		},
	},
	// 黎明的视为技：把武将牌上的牌当【杀】使用或打出
	//
	// 两个关键点：
	// 1. 必须是独立技能，不能写成 wsde_liming 的 subSkill——awakenSkill 会连带禁用主技能的子技能，
	//    而“使用武将牌上的牌”必须在黎明发动之后继续有效。
	// 2. 武将牌上（扩展区）的牌**不能**用纯 viewAs 技能直接选取。官方做法是 chooseButton + backup
	//    （参考 邓艾【急袭】、才辩、输粮）：先弹出 dialog 让玩家从扩展区挑一张，
	//    再由 backup 生成一个临时视为技来完成这次使用/打出。
	wsde_liming_sha: {
		// 这个技能自身不播报，出【杀】的语音在 wsde_liming_buff 里手动播放
		audio: false,
		// 把武将牌上的牌显示在技能标记里
		mark: true,
		marktext: "黎",
		intro: {
			content: "expansion",
			markcount: "expansion",
		},
		enable: ["chooseToUse", "chooseToRespond"],
		// 让系统/AI 知道“武将牌上的牌可以当【杀】用”
		hiddenCard(player, name) {
			return name == "sha" && player.getExpansions("wsde_liming").length > 0;
		},
		filter(event, player) {
			const cards = player.getExpansions("wsde_liming");
			if (!cards.length) {
				return false;
			}
			// 至少有一张现在真的能当【杀】使用（没有合法目标时按钮就不该亮）
			return cards.some(card => event.filterCard(get.autoViewAs({ name: "sha" }, [card]), player, event));
		},
		chooseButton: {
			dialog(event, player) {
				return ui.create.dialog("黎明", player.getExpansions("wsde_liming"), "hidden");
			},
			filter(button, player) {
				const card = button.link;
				if (!game.checkMod(card, player, "unchanged", "cardEnabled2", player)) {
					return false;
				}
				const evt = _status.event.getParent();
				return evt.filterCard(get.autoViewAs({ name: "sha" }, [card]), player, evt);
			},
			check(button) {
				// 这些牌本来也只能这么用，AI 评分给高一点
				return 6;
			},
			backup(links, player) {
				return {
					// 这里不能再引用 wsde_liming 的语音：使用本视为技时引擎会按 backup 技能
					// 的 audio 播报，写 "wsde_liming" 会误播【黎明】觉醒的台词（行动开始）。
					// 出【杀】的语音（作战中4）由 wsde_liming_buff 在 useCard1 里手动播放。
					audio: false,
					// selectCard: -1 = 不再询问选牌，直接用上面挑好的那张
					selectCard: -1,
					// position "x" = 武将牌上的牌（扩展区）
					position: "x",
					filterCard(card) {
						return card == lib.skill.wsde_liming_sha_backup.card;
					},
					viewAs: { name: "sha" },
					card: links[0],
				};
			},
			prompt(links, player) {
				return "黎明：将" + get.translation(links[0]) + "当【杀】使用或打出";
			},
		},
		subSkill: {
			// 引擎会把上面的 backup() 写进这个技能
			backup: {},
		},
		group: ["wsde_liming_buff", "wsde_liming_damage"],
		ai: {
			order: 6,
			respondSha: true,
			result: {
				player(player) {
					return 1;
				},
			},
			skillTagFilter(player) {
				return player.getExpansions("wsde_liming").length > 0;
			},
		},
	},
	// 黎明的【杀】：无距离限制 + 无法被响应 + 使用后翻面
	wsde_liming_buff: {
		audio: false,
		charlotte: true,
		locked: true,
		silent: true,
		popup: false,
		sourceSkill: "wsde_liming_sha",
		mod: {
			targetInRange(card, player, target) {
				if (card.name != "sha") {
					return;
				}
				// 选目标时这些牌还在武将牌上，扩展区与 gaintag 任一命中即可
				if (card.cards?.some(cardx => player.getExpansions("wsde_liming").includes(cardx) || cardx.hasGaintag("wsde_liming"))) {
					return true;
				}
			},
		},
		trigger: { player: "useCard1" },
		filter(event, player) {
			// 只有由本视为技转化出的【杀】才享受这些加成
			// （实际使用时技能名是 wsde_liming_sha_backup，需要靠 sourceSkill 解析）
			return isLimingShaSkill(event.skill);
		},
		async content(event, trigger, player) {
			// 出【杀】语音：作战中4（手动播放，路径里的 ext: 会被解析成 extension/ 目录）
			game.playAudio("ext:方舟/skill/wsde_liming_sha1.mp3");
			// directHit：此牌不能被响应（无法用【闪】等响应）
			trigger.directHit.addArray(game.players);
			// 双保险：使用结算时也不再检查距离
			trigger.nodistance = true;
			// 若如此做，你翻面
			await player.turnOver();
		},
	},
	// 黎明的【杀】造成的伤害 +1
	wsde_liming_damage: {
		audio: false,
		charlotte: true,
		locked: true,
		silent: true,
		popup: false,
		sourceSkill: "wsde_liming_sha",
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			// 沿事件链找到使用牌事件，确认这张【杀】是黎明转化的
			return isLimingShaSkill(event.getParent("useCard")?.skill);
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 初雪 · 圣女（魏 / 3体力）
	//
	// 四个技能分成两组：
	//   【雪景】独立工作，监听所有角色「使用或打出牌」，按距离累计计数；
	//   【祈愿】是转换技，在【圣山】与【霜涛】之间来回切换，
	//   这两个技能都用 mod 修改「其他角色到你的距离」，方向相反且互斥。
	// ══════════════════════════════════════════════════════════════

	// ── 雪景 ─────────────────────────────────────────────────────
	// 描述：锁定技，其他角色每累计使用或打出X张牌后，其弃置一张牌
	//       （X为其与你当前的距离，至少为2）。此计数在其回合结束后重置。
	cx_xuejing: {
		// 三条语音（行动开始 / 选中干员1 / 选中干员2），发动时随机一条
		audio: "ext:方舟/skill:3",
		locked: true,
		forced: true,
		// 计数是高频动作，用 silent + popup:false 压掉每一次的提示与动画；
		// 真正「发动」（令其弃牌）的那一次在 content 里手动 logSkill 播报
		silent: true,
		popup: false,
		// global：任意角色使用或打出牌都会轮到本技能
		trigger: { global: ["useCard", "respond"] },
		filter(event, player) {
			// 只数「其他角色」，自己用牌不算
			const target = event.player;
			return !!target && target != player && target.isIn();
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			// X = 该角色与你的「当前距离」，至少为 2。
			// get.distance 会把圣山 / 霜涛的 globalTo 修正算进去，所以拿到的就是当前距离
			const limit = Math.max(2, get.distance(target, player));
			const count = (target.getStorage("cx_xuejing") || 0) + 1;
			if (count < limit) {
				// 还没数满，只记账。计数存在对方身上，联机时会随 storage 同步
				target.setStorage("cx_xuejing", count);
				return;
			}
			// 数满 X 张：计数清零，其弃置一张牌
			target.setStorage("cx_xuejing", 0);
			player.logSkill("cx_xuejing", target);
			if (target.countCards("he") > 0) {
				await target.chooseToDiscard("雪景：弃置一张牌", "he", true);
			}
		},
		group: ["cx_xuejing_reset"],
	},
	// 雪景的收尾：计数在其回合结束后重置。
	// phaseEnd 是把整个 phaseList 走完之后才触发一次的时机（不是每个阶段结束时），
	// 所以它就是「回合结束后」。
	cx_xuejing_reset: {
		audio: false,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		charlotte: true,
		sourceSkill: "cx_xuejing",
		trigger: { global: "phaseEnd" },
		filter(event, player) {
			// 只清别人的计数，且没计数时不必白跑一趟
			return event.player != player && (event.player.getStorage("cx_xuejing") || 0) > 0;
		},
		async content(event, trigger, player) {
			trigger.player.setStorage("cx_xuejing", 0);
		},
	},

	// ── 祈愿（转换技）─────────────────────────────────────────────
	// 描述：转换技，①结束阶段，你可以失去【圣山】并获得【霜涛】。
	//       ②结束阶段，你可以失去【霜涛】并获得【圣山】。
	cx_qiyuan: {
		// 两条语音（部署1 / 部署2），发动时随机一条
		audio: "ext:方舟/skill:2",
		// 转换技三件套：zhuanhuanji 开关 + mark 标记 + intro 说明当前在哪一面
		zhuanhuanji: true,
		mark: true,
		marktext: "祈",
		intro: {
			// storage 就是 player.storage.cx_qiyuan：假 = ①，真 = ②
			content(storage, player) {
				return !storage
					? "结束阶段，你可以失去【圣山】并获得【霜涛】。"
					: "结束阶段，你可以失去【霜涛】并获得【圣山】。";
			},
		},
		// 「结束阶段」= phaseJieshuBegin（无名杀的阶段事件用的是拼音命名）
		trigger: { player: "phaseJieshuBegin" },
		filter(event, player) {
			// ①要有圣山、②要有霜涛才有意义，免得出现「发动了却什么都没变」
			return !player.storage.cx_qiyuan ? player.hasSkill("cx_shengshan") : player.hasSkill("cx_shuangtao");
		},
		// 描述是「你可以」，所以这是可发动的触发技；这里给 AI 一个总是发动的判断
		check(event, player) {
			return true;
		},
		async content(event, trigger, player) {
			// 转换技发动时的专用音效（素材：圣聆初雪/转换技音效）
			playSfx("转换技音效");
			// changeZhuanhuanji 会把 player.storage[技能名] 在 true / false 间翻转
			const bool = player.storage[event.name];
			if (!bool) {
				// ①失去圣山、获得霜涛（先移除再添加，避免两个距离修正同时生效）
				player.removeSkill("cx_shengshan");
				player.addSkill("cx_shuangtao");
			} else {
				// ②失去霜涛、获得圣山
				player.removeSkill("cx_shuangtao");
				player.addSkill("cx_shengshan");
			}
			player.changeZhuanhuanji(event.name);
		},
		// 声明衍生技：霜涛不出现在武将技能表里，只能由本技能获得
		derivation: ["cx_shuangtao"],
	},

	// ── 圣山 ─────────────────────────────────────────────────────
	// 描述：锁定技，每轮开始时，你获得1点护甲；
	//       其他角色计算与你的距离时+1；你的手牌上限+2。
	cx_shengshan: {
		// 两条语音（作战中1 / 作战中2），每轮开始时随机一条
		audio: "ext:方舟/skill:2",
		locked: true,
		forced: true,
		// 每轮开始（一「轮」= 场上每名角色各行动过一次）
		trigger: { global: "roundStart" },
		async content(event, trigger, player) {
			await player.changeHujia(1);
		},
		mod: {
			// globalTo 修饰「别人 → 你」的距离（和【飞影】是同一个字段）
			globalTo(from, to, distance) {
				return distance + 1;
			},
			maxHandcard(player, num) {
				return num + 2;
			},
		},
	},

	// ── 霜涛（衍生技）─────────────────────────────────────────────
	// 描述：锁定技，你使用的【杀】可以指定至多三名角色为目标；
	//       其他角色计算与你的距离时-1。
	cx_shuangtao: {
		// 两条语音（作战中3 / 作战中4）
		audio: "ext:方舟/skill:2",
		locked: true,
		forced: true,
		// 纯 mod 技能本身没有发动时机，这里额外挂一个「使用【杀】时」，
		// 让语音在真正体现效果的时候播出来（效果全部由下面的 mod 承担）
		trigger: { player: "useCard" },
		filter(event, player) {
			return event.card?.name == "sha";
		},
		async content(event, trigger, player) {
			// 效果在 mod 里，这里只负责播报：
			// 出【杀】时的攻击音效（素材：圣聆初雪/攻击音效）
			playSfx("攻击音效");
		},
		mod: {
			// selectTarget：range = [目标数下限, 目标数上限]，-1 表示无上限（同【神技】）
			selectTarget(card, player, range) {
				if (card.name != "sha" || range[1] == -1) {
					return;
				}
				range[1] = Math.max(range[1], 3);
			},
			// globalTo 修饰「别人 → 你」的距离
			globalTo(from, to, distance) {
				return distance - 1;
			},
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 遥 · 夏末游鳞（群 / 3体力）
	//
	// 「浮泡」是一个**标记**（存在 player.storage 里，靠 lib.skill.yao_fupao 的 intro 渲染），
	// 不是挂在角色身上的技能。它串起两条链路：
	//   拥有「浮泡」的干员受到伤害 -> 回复1点体力、移去「浮泡」（浮光的锁定技部分）
	//   「浮泡」被移去 -> 若遥身上挂着幽萤的持续效果，对标记者的邻居各造成1点伤害
	// 「移去标记」之所以能被监听到，是因为 removeMark 内部会 createEvent("removeMark")。
	// ══════════════════════════════════════════════════════════════

	// 浮泡特效的实现见文件顶部的 yaoSetFupaoFx()（那里是模块作用域，
	// 而这里是 skills 对象字面量内部，不能声明 const / function）。

	// 「浮泡」标记：只是一个 intro 容器。
	// addMark / removeMark 会自己调用 markSkill / unmarkSkill，
	// 而 markSkill 只要求 lib.skill[标记名].intro 存在就能渲染出标记，
	// 所以这里不需要把它 addSkill 给任何角色。
	yao_fupao: {
		audio: false,
		charlotte: true,
		mark: true,
		marktext: "浮泡",
		intro: {
			name: "浮泡",
			content: "锁定技，当一名拥有“浮泡”标记的干员受到伤害后，其回复1点体力，然后移去其“浮泡”标记。",
		},
	},

	// ── 浮光 ─────────────────────────────────────────────────────
	// 描述：回合开始时，你可以令你攻击范围内的至多两名没有“浮泡”标记的其他干员各获得“浮泡”标记。
	//       锁定技，当一名拥有“浮泡”标记的干员受到伤害后，其回复1点体力，然后移去其“浮泡”标记。
	yao_fuguang: {
		// 三条语音（选中干员2 / 部署1 / 部署2），发动时随机一条
		audio: "ext:方舟/skill:3",
		// 「回合开始时」= phaseZhunbeiBegin（准备阶段开始时）
		trigger: { player: "phaseZhunbeiBegin" },
		filter(event, player) {
			// 自己没有「浮泡」时一定值得发动（可以直接给自己挂）；
			// 否则要求至少有一个「在攻击范围内、且还没有浮泡」的其他角色
			if (!player.hasMark("yao_fupao")) {
				return true;
			}
			return game.hasPlayer(current => current != player && player.inRange(current) && !current.hasMark("yao_fupao"));
		},
		// 描述是「你可以」，所以是可选触发技；给 AI 一个发动判断
		check(event, player) {
			// 给自己挂「浮泡」是纯收益（受伤后回血），优先
			if (!player.hasMark("yao_fupao")) {
				return true;
			}
			return game.hasPlayer(
				current => current != player && player.inRange(current) && !current.hasMark("yao_fupao") && get.attitude(player, current) > 0
			);
		},
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget({
					selectTarget: [1, 2],
					prompt: "浮光：令至多两名干员获得“浮泡”",
					filterTarget(card, player, target) {
						if (target.hasMark("yao_fupao")) {
							return false;
						}
						// 自己不受攻击范围限制：inRange 对自身恒为 false
						//（源码里 `if (from == to) return false`），
						// 所以必须在这里单独放行，否则「包括自身」根本选不中自己
						return target == player || player.inRange(target);
					},
					// 「浮泡」是受伤后回血，对自己和队友都是收益，按态度给分；
					// 自己额外加权，保证 AI 会优先把自己算进去
					ai(target) {
						return target == player ? 10 : get.attitude(player, target);
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			for (const target of result.targets) {
				target.addMark("yao_fupao", 1);
			}
		},
		group: ["yao_fuguang_recover", "yao_fupao_fx"],
	},
	// 浮光的锁定技部分：拥有「浮泡」的干员受到伤害后，回复1点体力并移去标记
	yao_fuguang_recover: {
		audio: false,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		charlotte: true,
		sourceSkill: "yao_fuguang",
		trigger: { global: "damageEnd" },
		filter(event, player) {
			return event.num > 0 && event.player.hasMark("yao_fupao");
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			// 按描述的顺序：先回复1点体力，然后移去「浮泡」标记
			await target.recover();
			target.removeMark("yao_fupao", target.countMark("yao_fupao"));
		},
	},

	// 浮泡特效的驱动：跟着标记的增删走。纯视觉，不产生任何结算。
	// 挂在遥身上（由 yao_fuguang group 进来）—— 浮泡本来就是遥赋予的，
	// 遥不在场自然不会有人挂浮泡。
	yao_fupao_fx: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		forced: true,
		trigger: { global: ["addMark", "removeMark", "die"] },
		filter(event) {
			if (event.markName == "yao_fupao") {
				return true;
			}
			// 阵亡时标记是被 unmarkSkill 静默清掉的（不产生 removeMark 事件），
			// 所以额外接一下 die，免得泡泡留在阵亡的角色卡上
			return event.name == "die" && !!event.player && event.player.hasMark("yao_fupao");
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			if (!target || !target.node) {
				return;
			}
			if (trigger.name == "addMark") {
				yaoSetFupaoFx(target, true);
				return;
			}
			// removeMark 要减到 0 才摘；die 则一律摘
			if (trigger.name == "die" || target.countMark("yao_fupao") <= 0) {
				yaoSetFupaoFx(target, false);
			}
		},
	},

	// ── 幽萤 ─────────────────────────────────────────────────────
	// 描述：出牌阶段限一次，你可以弃置一张手牌，若如此做，直到你的下个准备阶段开始前，
	//       当一名干员的“浮泡”标记被移去时，你对其距离1以内的所有其他干员各造成1点伤害。
	yao_youying: {
		// 四条语音（作战中1~4），发动时随机一条
		audio: "ext:方舟/skill:4",
		enable: "phaseUse",
		usable: 1,
		// 主动技默认会把选中的牌弃置，所以「弃置一张手牌」只要声明选牌范围即可
		filterCard: true,
		position: "h",
		selectCard: 1,
		filter(event, player) {
			return player.countCards("h") > 0;
		},
		async content(event, trigger, player) {
			// 「直到你的下个准备阶段开始前」= 挂一个持续到 phaseZhunbeiBegin 的临时技能。
			// addTempSkill 的 expire 写成 { player: 时机名 }，表示「你自己的这个时机到来时移除」。
			player.addTempSkill("yao_youying_buff", { player: "phaseZhunbeiBegin" });
		},
		ai: {
			order: 5,
			result: {
				player(player) {
					// 手上有多余的牌、场上有浮泡时才值得弃
					return game.hasPlayer(current => current.hasMark("yao_fupao")) ? 1 : 0;
				},
			},
		},
	},
	// 幽萤的持续效果：监听「浮泡」标记被移去
	yao_youying_buff: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "yao_youying",
		// removeMark 内部会 createEvent("removeMark")，所以这里能像普通时机一样监听
		trigger: { global: "removeMark" },
		filter(event, player) {
			return event.markName == "yao_fupao";
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			// 「其距离1以内的所有其他干员」：排除被移去标记的那位自己
			const targets = game.filterPlayer(current => current != target && get.distance(target, current) <= 1);
			for (const current of targets) {
				await current.damage(1, player);
			}
		},
	},


	// ══════════════════════════════════════════════════════════════
	// 结城理 · 月行水上（群 / 三张面具 / 每张 1 体力）
	//
	// 三张武将牌（jycl_makoto1/2/3）显示名都叫「结城理」，描述上都只有「面具」一个技能，
	// 所以下面三个主技能在 translate 里都译作「面具」，各自把锁定部分 / 主动部分 /
	// 换牌时机用 mod + group + subSkill 拼在一起 —— 描述上依然是「一个技能」。
	//
	// 语音：主技能各挂 audio: "ext:方舟/skill:4"，引擎会按技能名去找
	// skill/<技能名>1..4.mp3 并随机播一个；因为子技能的文件名会变成
	// <主技能名>_<子技能名>N.mp3，所以换牌时不由引擎播，而是 jyclSwapMask 里
	// 手动 game.trySkillAudio(主技能名, ...) 播主技能那四个，避免再复制一份素材。
	// ══════════════════════════════════════════════════════════════

	// ── 面具①（唯一的可选武将牌）────────────────────────────────
	// 锁定技，你的手牌上限+3；死亡时，更改武将牌。
	// 出牌阶段，你可以失去一点体力。
	jycl_mianju_a: {
		audio: "ext:方舟/skill:4",
		// locked（而不是 forced）让他被引擎认定成锁定技（get.is.locked 会看这个字段），
		// 又不会把下面的主动技变成「必须发动」
		locked: true,
		enable: "phaseUse",
		filter(event, player) {
			// 人类玩家想什么时候点就什么时候点；
			// AI（含托管）只在上面那笔账算得过来时才给自己放血 ——
			// 早先这个 filter 恒返回 true、技能又没有 ai 字段，
			// 于是 AI 眼里这是一个「纯亏 1 点体力」的选项，它一次都不会点。
			if (jyclIsAuto(player)) {
				return jyclShouldBleed(player);
			}
			return true;
		},
		async content(event, trigger, player) {
			// ★ 先打上「正在卖血」的标记，再失血。
			//   濒死流程会**先问所有人要不要用【桃】/【酒】救他**（见 content.js 的 _save），
			//   而 AI 自己往往会掏一张【桃】把自己拉回 1 血 —— 那样既没换成面具、
			//   又白掉 1 点体力，这笔账完全亏。
			//   main/content.js 里包装的 lib.filter.cardSavable 认这个标记，
			//   会把 AI 的【桃】/【酒】挡掉（人类玩家不受影响）。
			//   标记必须在 loseHp **之前**设、之后清：求桃发生在 loseHp 内部。
			player.storage.jycl_selling = true;
			try {
				// 全员只有 1 点体力，所以这一下就是主动把自己打进濒死，
				// 从而把面具推进到下一张（1→2→3）—— 这是这套武将唯一的主动开关
				await player.loseHp(1);
			} finally {
				delete player.storage.jycl_selling;
			}
		},
		mod: {
			maxHandcard(player, num) {
				return num + 3;
			},
		},
		group: ["jycl_mianju_a_die"],
		subSkill: {
			die: jyclDieMask("jycl_makoto1", "jycl_makoto2"),
		},
		ai: {
			// order 压到最低：先把该用的牌用完，最后再回来卖血换面具
			order: 1,
			result: { player: 1 },
		},
	},

	// ── 面具② ───────────────────────────────────────────────────
	// 锁定技，你的手牌上限+3；你使用【杀】时可至多指定两个目标；
	// 死亡或回合开始时，更改武将牌。
	// 获得该技能时，抽一张牌，视为使用一张无距离限制且不计入次数限制的【杀】。
	// 出牌阶段，你可以失去一点体力。
	jycl_mianju_b: {
		audio: "ext:方舟/skill:4",
		locked: true,
		enable: "phaseUse",
		filter(event, player) {
			// 同面具①：人类随便点，AI 只在算得过来时放血
			if (jyclIsAuto(player)) {
				return jyclShouldBleed(player);
			}
			return true;
		},
		async content(event, trigger, player) {
			// 同面具①：卖血期间不许 AI 用【桃】/【酒】把自己救回来
			//（AI 本来就不会主动点这个技能，但托管 / 人类玩家点了以后
			//  若中途转成自动，这条也管用）
			player.storage.jycl_selling = true;
			try {
				await player.loseHp(1);
			} finally {
				delete player.storage.jycl_selling;
			}
		},
		mod: {
			maxHandcard(player, num) {
				return num + 3;
			},
			// range = [目标数下限, 目标数上限]，-1 表示无上限（同【神技】/【霜涛】）
			selectTarget(card, player, range) {
				if (card.name != "sha" || range[1] == -1) {
					return;
				}
				range[1] = Math.max(range[1], 2);
			},
		},
		group: ["jycl_mianju_b_die", "jycl_mianju_b_begin"],
		subSkill: {
			die: jyclDieMask("jycl_makoto2", "jycl_makoto3"),
			begin: jyclBeginMask("jycl_makoto2"),
		},
		ai: {
			// 比面具①还靠后：面具②的「杀可双目标」是本回合最值钱的东西，
			// 一定要等它用出去之后再考虑换成面具③
			order: 1,
			result: { player: 1 },
		},
	},

	// ── 面具③ ───────────────────────────────────────────────────
	// 锁定技，你的手牌上限+3；回合开始时，更换武将牌。
	// 获得该技能时，抽一张牌。
	// 每回合限一次，你可以回复 1 点体力（濒死时也可以发动来自救）。
	jycl_mianju_c: {
		audio: "ext:方舟/skill:4",
		locked: true,
		enable: "phaseUse",
		// usable: 1 = 每回合限一次
		usable: 1,
		filter(event, player) {
			// 满血时回复没有意义
			return player.isDamaged();
		},
		async content(event, trigger, player) {
			await player.recover();
		},
		mod: {
			maxHandcard(player, num) {
				return num + 3;
			},
		},
		// 面具③ 没有「死亡时更改武将牌」：它就是最后一张，死在这里就是真的死了
		group: ["jycl_mianju_c_begin", "jycl_mianju_c_dying"],
		subSkill: {
			begin: jyclBeginMask("jycl_makoto3"),
			// 濒死自救。上面那条 enable: "phaseUse" 只在自己受伤时才亮，
			// 而结城理体力上限只有 1：满血(1/1)时 isDamaged() 为 false，
			// 一旦掉到 0 就已经是濒死、根本不在出牌阶段 —— 所以只靠出牌阶段
			// 那一段，这个回复效果实战里永远触发不到。这里补一个濒死时机，
			// 让「回复 1 点体力」真正能用：濒死时 recover 把体力拉回 1，
			// dying 收尾处再检查 player.hp <= 0 就不会判死。
			dying: {
				audio: false,
				charlotte: true,
				trigger: { player: "dying" },
				// 不加 forced：描述是「你可以」，由玩家自己决定用不用
				usable: 1,
				filter(event, player) {
					return player.hp <= 0;
				},
				async content(event, trigger, player) {
					await player.recover();
				},
			},
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 逻各斯 · 女妖之主（群 / 3体力）
	//
	// 【提喻】用**弃牌的颜色**分岔：红色是「把人推远 + 补他一张牌」，
	// 黑色是「把人拉近 + 封他一张手牌」。两条距离修正都是「本局游戏中」永久的，
	// 所以存在 player.storage.lgs_tiyu_dist 里（playerid -> 累计增减量），
	// 由 mod.globalFrom 读取 —— 【马术】用的也是这个字段，只是它写死了 -1。
	//
	// 【殁亡】是纯锁定技：盯着全场 changeHp，谁掉到 1 血就再补一刀。
	// ══════════════════════════════════════════════════════════════

	// ── 提喻 ─────────────────────────────────────────────────────
	// 描述：每回合限两次，你可以弃置一张红色牌或黑色牌并选择一名角色，
	//       然后依弃置牌的颜色执行对应效果：
	//       红色：本局游戏中，你计算与其的距离+1，其摸一张牌。
	//       黑色：本局游戏中，你计算与其的距离-1；直到你的下个结束阶段，
	//             其随机一张未受此技能影响的手牌不能被使用、打出或弃置。
	lgs_tiyu: {
		// 技能语音：素材是逻各斯的 7 条台词（作战中1~4 / 选中干员2 / 部署1 / 部署2）。
		// 作者要求「所有技能都是所有语音随机」，所以两个技能各复制一份**同序号**的副本，
		// 引擎按 <技能名><序号>.mp3 找文件（见 get/audio.js 的 textMapWithIndex）。
		audio: "ext:方舟/skill:7",
		enable: "phaseUse",
		// 每回合限两次。usable 在主动技上走 player.getStat("skill") 计数，
		// 在触发技上走 triggerSkill 计数 —— 这个技能是主动技，用的是前者。
		usable: 2,
		// storage 在技能获得时就建好，mod 里才好无脑读
		init(player) {
			if (!player.storage.lgs_tiyu_dist) {
				player.storage.lgs_tiyu_dist = {};
			}
		},
		filter(event, player) {
			// 至少得有一张红牌或黑牌**可弃**（无色牌不算）。
			// 这里刻意**不**去调 lib.filter.cardDiscardable：它会顺着
			// _status.event.getParent().name 取事件名，而技能 filter 被调用的
			// 上下文不保证有 parent，一旦取不到就是 TypeError、整个技能直接不亮。
			// 改用直接查 gaintag —— 被【提喻】封住的牌本来就不能弃，
			// 这个判断既准确又不依赖任何事件上下文。
			return player.hasCard(card => lgsIsRedOrBlack(card) && !card.hasGaintag(LGS_SEAL), "he");
		},
		async content(event, trigger, player) {
			// ★ 确保封印技已经注册为全局技能。
			//
			//   注册的**主**位置在这里，而不是扩展的 content 钩子：扩展钩子跑在
			//   「扩展加载」阶段，那时角色包还只是躺在 lib.imported.character 里，
			//   要等模式加载调 loadCharacter 才合并进 lib.skill —— 也就是说
			//   main/content.js 里那句 addGlobalSkill 多半会因为 lib.skill 里还没有
			//   这个技能而静默失败（它内部 `if (!info) return false`）。
			//   放到这里最稳：玩家点得出技能就说明游戏已经在跑、lib.skill 一定齐了。
			//
			//   两次调用都是幂等的（lib.skill.global 是去重数组），所以留着双保险。
			game.addGlobalSkill(LGS_SEAL);

			// 弃牌 + 选人一步做完（chooseCardTarget），而不是分两次 chooseCard/chooseTarget：
			// 分两步的话，玩家弃完牌再取消选人就会白白亏一张牌。
			const { bool, cards, targets } = await player
				.chooseCardTarget({
					prompt: "提喻：弃置一张红色牌或黑色牌，并选择一名角色",
					position: "he",
					selectCard: 1,
					filterCard(card, player) {
						// 颜色要对，而且这张牌不能是**已经被自己封住**的 ——
						// 否则选中它之后 discard 会被自己的封锁挡住。
						// 直接查 gaintag 而不用 lib.filter.cardDiscardable：
						// 后者要顺着 _status.event.getParent() 取事件名，这里是
						// chooseCardTarget 的过滤回调，没必要去赌那个上下文。
						return lgsIsRedOrBlack(card) && !card.hasGaintag(LGS_SEAL);
					},
					filterTarget(card, player, target) {
						// 描述是「一名角色」（不是「一名其他角色」），所以自己也能选
						return true;
					},
					// 弃牌偏好：先扔没用的
					ai1: card => get.unuseful(card),
					// 选人偏好**取决于弃的是什么颜色**：红色是给好处（挑队友），
					// 黑色是压制（挑敌人）。ai2 里可以读到已经选好的牌。
					ai2(target) {
						const me = get.player();
						const card = ui.selected.cards[0];
						const attitude = get.attitude(me, target);
						return card && get.color(card) == "red" ? attitude : -attitude;
					},
				})
				.forResult();
			if (!bool || !cards.length || !targets.length) {
				return;
			}
			const card = cards[0];
			const target = targets[0];
			const color = get.color(card);
			await player.discard(cards);

			// ① 距离修正：本局游戏永久，按 playerid 累加。
			//    对同一名角色反复发动会叠加（红 +1 / 黑 -1 互相抵消），
			//    描述里没有「至多」之类的上限，所以就是累加。
			const map = player.storage.lgs_tiyu_dist || (player.storage.lgs_tiyu_dist = {});
			map[target.playerid] = (map[target.playerid] || 0) + (color == "red" ? 1 : -1);

			// ② 各自的附加效果
			if (color == "red") {
				await target.draw();
			} else {
				// 「随机一张未受此技能影响的手牌」＝还没有被这个 tag 标过的手牌
				const pool = target.getCards("h", c => !c.hasGaintag(LGS_SEAL));
				if (pool.length) {
					// randomGet 来自 Array.prototype.randomGet（init/polyfill.js），
					// 和官方「随机弃置一张牌」(player.randomDiscard) 是同一个随机源
					const sealed = pool.randomGet();
					// ★ 用 player.addGaintag（而不是 card.addGaintag）：前者是广播版，
					//   gaintag 属于各客户端本地的牌数据 + DOM，不广播就各端不一致
					target.addGaintag(sealed, LGS_SEAL);
					// ★ 每张牌**各自**记一个到期轮数（不是整批一个）。
					//
					//   整个技能最容易写错的地方就在这个 "+1"：
					//   【提喻】是 enable: "phaseUse"，只能在**逻各斯自己的出牌阶段**
					//   发动 —— 而同一个回合的 phaseJieshuBegin 紧接着就来。
					//   把「直到你的下个结束阶段」按字面当成本回合的结束阶段，
					//   封印会在几秒内被自己解掉，对手根本没机会碰到那张牌，
					//   效果等于没有（实机就是这么失败的）。
					//   所以到期轮数记 roundNumber + 1：本回合的结束阶段跳过、
					//   下一回合的结束阶段才解除。
					//
					//   game.roundNumber 在「轮的第一个角色回合开始」时递增
					//   （content.js 的 phaseBegin 处理里 game.roundNumber++），
					//   每轮只变一次，正好能当"跨了一轮没有"的判据。
					lgsEnsureSealmark(player);
					player.storage.lgs_tiyu_sealmark[String(sealed.cardid)] = game.roundNumber + 1;
					// ★ 这里**不需要** target.addSkill(LGS_SEAL)。
					//   提供 mod 的 lgs_tiyu_seal 是**全局技能**（本函数开头
					//   用 game.addGlobalSkill 注册的）—— 全局技能的 mod 会出现在
					//   每个人的 getModableSkills() 里（checkMod 会 concat
					//   lib.skill.global），所以不管这张牌在谁手上都会被拦住。
					//   上一版写的是「给目标 addSkill」，游戏里没生效。
				}
			}
		},
		mod: {
			// globalFrom 修饰「自己 → 别人」的距离（【马术】就是 distance - 1）。
			// 这里读 storage 里的累计值，没有记录的角色原样不动。
			globalFrom(from, to, distance) {
				const map = from.storage?.lgs_tiyu_dist;
				if (!map) {
					return;
				}
				const delta = map[to.playerid];
				if (!delta) {
					return;
				}
				return distance + delta;
			},
		},
		// 到逻各斯的下个结束阶段统一解除封印
		group: ["lgs_tiyu_clear"],
		// lgs_tiyu_seal 是提供封锁 mod 的**全局技能**（发动时用 game.addGlobalSkill 提升）；
		// lgs_tiyu_sealmark 是记录「每张牌各自的到期轮数」的 storage 容器。
		// 两者都声明成衍生技（同初雪的 cx_qiyuan→cx_shuangtao）：一是让意图明确，
		// 二是联机模式下引擎会完整保留 derivation 里的技能定义。
		derivation: ["lgs_tiyu_seal", "lgs_tiyu_sealmark"],
		subSkill: {
			clear: {
				audio: false,
				charlotte: true,
				// forced（而不是 direct）：这是纯收尾，既不该弹确认框，
				// 也不该因为 direct 而错过 —— forced 的语义就是「锁定、自动发动」
				forced: true,
				trigger: { player: "phaseJieshuBegin" },
				filter(event, player) {
					// 只有真的封过牌才需要跑 —— 清理要扫遍场上所有牌 + 牌堆 + 弃牌堆
					return Object.keys(player.storage.lgs_tiyu_sealmark || {}).length > 0;
				},
				// ★ 这里必须写 async，哪怕函数体里一个 await 都没有。
				//
				//   引擎的 ContentCompiler 按函数类型分派（gameEvent/compilers/）：
				//     · AsyncCompiler  filter = content instanceof AsyncFunction
				//                      → ArrayCompiler → Reflect.apply(原函数)
				//                        **直接调用，模块闭包完好**
				//     · StepCompiler   filter = 普通同步函数
				//                      → new Function("topVars","event","trigger","player", 源码)
				//                        **整个函数体被重新编译**，只能看见
				//                        _status / lib / game / ui / get / ai 这六个
				//                        （StepParser.topVars），模块作用域里的一切全丢
				//
				//   第一版这里写的是同步 content，实机直接炸：
				//     ReferenceError: lgsClearSeal is not defined
				//   报错栈停在 .../compilers/StepCompiler.js:80 的 packStep。
				//   也就是说：**同步 content 里调用本文件的任何辅助函数/常量都会崩**。
				async content(event, trigger, player) {
					// 逐张比对 cardid 的到期轮数，只清**已经到期**的那些。
					// 本回合（封印的那一轮）的结束阶段什么都不清 —— 见 lgsClearSeal 的说明。
					lgsClearSeal(player);
				},
			},
		},
	},

	// ── 提喻的封印承载技（衍生，不是武将技能）──────────────────────
	// 唯一作用是提供下面这组 mod。它由【提喻】在发动时用 game.addGlobalSkill
	// 提升为**全局技能** —— 因为 cardEnabled2 / cardDiscardable / canBeDiscarded
	// 最后都走 game.checkMod(..., <技能拥有者>)，而「技能拥有者」是**正在用牌的人**；
	// 挂到某一个人身上是封不住别人的（详见文件顶部第 ② 条）。
	lgs_tiyu_seal: {
		audio: false,
		charlotte: true,
		mod: {
			// cardEnabled 和 cardRespondable **都**会先查 cardEnabled2
			// （见 library/index.js 的 lib.filter），所以这一条同时封住「使用」和「打出」
			cardEnabled2(card) {
				if (card.hasGaintag(LGS_SEAL)) {
					return false;
				}
			},
			// 自己弃置（出牌阶段弃牌、各种「弃置一张牌」的代价）
			cardDiscardable(card) {
				if (card.hasGaintag(LGS_SEAL)) {
					return false;
				}
			},
			// 别人弃置／拿走（【过河拆桥】【顺手牵羊】走的是 canBeDiscarded）
			canBeDiscarded(card) {
				if (card.hasGaintag(LGS_SEAL)) {
					return false;
				}
			},
			// 濒死求桃时，也不能拿它当【桃】用
			cardSavable(card) {
				if (card.hasGaintag(LGS_SEAL)) {
					return false;
				}
			},
		},
	},

	// ── 提喻的「封印计时」（衍生隐藏技，纯 storage 容器）──────────
	// 它没有任何 trigger / mod / enable —— 唯一的用途是给
	//     player.storage.lgs_tiyu_sealmark = { "<cardid>": 到期轮数 }
	// 这份数据一个明确的归属，好让**每张被封印的牌各自计时**
	// （而不是整批共用一个到期时间）。
	// 读写都走模块顶部的 lgsEnsureSealmark / lgsClearSeal。
	lgs_tiyu_sealmark: {
		audio: false,
		charlotte: true,
		init(player) {
			if (!player.storage.lgs_tiyu_sealmark) {
				player.storage.lgs_tiyu_sealmark = {};
			}
		},
		// 技能被移除时把这份数据一起清掉，不留孤儿键
		onremove: "storage",
	},

	// ── 殁亡 ─────────────────────────────────────────────────────
	// 描述：锁定技，当你的攻击范围内的一名其他角色的体力值降至1时，其失去1点体力。
	lgs_mowang: {
		audio: "ext:方舟/skill:7",
		// locked 让他被引擎认成锁定技（get.is.locked 看这个字段，描述里的<b>锁定技</b>要对上）；
		// forced 才是「不弹确认框、自动发动」
		locked: true,
		forced: true,
		// changeHp 是全局时机：任何人的体力变动都会问一遍
		trigger: { global: "changeHp" },
		filter(event, player) {
			const target = event.player;
			if (!target || target == player) {
				return false;
			}
			if (!target.isIn()) {
				return false;
			}
			// 「降至 1」＝ 从**高于** 1 掉到 1。
			// gameEvent 的 changeHp content 是「player.hp += num」之后才
			// await event.trigger("changeHp")，所以触发时 target.hp 已经是新值，
			// 变动前的值在 event.originalHp 里（player.changeHp 里记的）。
			//
			// 这里用 originalHp > 1 判断、而不是用 num < 0：
			// 后者会把「从 0 被救回到 1」也算成「降至 1」。
			if (typeof event.originalHp != "number" || event.originalHp <= 1) {
				return false;
			}
			if (target.hp != 1) {
				return false;
			}
			// 攻击范围内。inRange 内部会走 getAttackRange() + 距离修正，
			// 所以【提喻】改过的距离在这里是生效的。
			return player.inRange(target);
		},
		async content(event, trigger, player) {
			// 再补一刀。掉到 0 会正常进入濒死结算。
			// 不会自锁：这次 loseHp 产生的 changeHp 事件里 originalHp 已经是 1，
			// 上面 filter 的第一关就挡住了。
			await trigger.player.loseHp(1);
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 普瑞赛斯 · 语言学家（群 / 两张武将牌 / 每张 3 体力）
	//
	// 两张武将牌（prss_priestess1 / prss_priestess2）显示名都叫「普瑞赛斯」，
	// 描述上都只显示一个技能，而且那个技能的**标题与描述都是空白**
	// （见 translate.js 顶部关于空标题的说明）——
	// 所以本段所有机制对玩家都是不透明的，能看到的只有一个空白技能按钮。
	//
	// 转换链：  武将牌① --死亡(觉醒)--> 武将牌②
	//   武将牌① 的能力是「改写」：每轮一次，把你参与指定目标的牌重新指定。
	//   武将牌② 的能力是「替牌」：别人抽牌前把牌堆顶的好牌换走、你的眼睛能看见
	//   所有人的手牌、以及连你自己抽牌时也会把烂牌换走。
	//   武将牌② 的三段全部静默（charlotte + direct + log:false + audio:false）。
	// ══════════════════════════════════════════════════════════════

	// ── 武将牌① 的主技能 ────────────────────────────────────────
	// 每轮限一次，当你使用卡牌指定目标、或你成为卡牌的目标时，
	// 可以重新为这张牌指定任意合法目标。
	prss_gaixie: {
		// 没有语音素材（素材目录里只有两张立绘），直接关掉 ——
		// audio: false 的技能不会被 trySkillAudio 找到文件
		audio: false,
		// 时机用 useCardToPlayer 而不是 useCard：
		//   它是「这张牌的某个目标被点亮」的那一刻，此时 useCard 的 content 还没开始
		//   逐个目标结算（content.js 里这一段之后才依次触发 useCardToPlayer），改 targets 来得及。
		//   用 event.isFirstTarget 限定只在第一个目标时问一次，
		//   否则多目标牌会按目标数重复询问。
		trigger: { global: "useCardToPlayer" },
		filter(event, player) {
			// 只问一次
			if (!event.isFirstTarget) {
				return false;
			}
			// 「你使用卡牌指定目标」或「你成为卡牌目标」
			if (event.player != player && event.target != player) {
				return false;
			}
			// 每轮限一次。触发技的 usable 是按**回合**统计的，做不到「每轮」，
			// 所以用轮历史自己数（官方 olsbchenzhi / clankaiji 都是这么写的）。
			if (
				typeof player.getRoundHistory == "function" &&
				player.getRoundHistory("useSkill", evt => evt.skill == PRSS_SKILL1).length
			) {
				return false;
			}
			// 至少要有一个「不在原目标里」的合法目标，否则点开也没得改 ——
			// 弹一个改不了的界面本身就是骚扰。（玩家点取消不消耗轮次数，
			// 所以这里挡的是体验，不是资源。）
			return game.hasPlayer(
				target => !event.targets.includes(target) && prssTargetEnabled(event.card, event.player, target)
			);
		},
		// cost 决定「要不要发动」：选完目标点确定 = 发动，点取消 = 不发动。
		// ★ 用 chooseTarget 的对象写法（player.js 的 chooseTarget 支持），
		//   selectTarget 传数字会被自动补成 [n, n]。
		//   cost 同样必须是 async —— 它和 content 一样会被当作「本模块的函数」直接调用。
		async cost(event, trigger, player) {
			event.result = await player
				.chooseTarget({
					prompt: `${get.translation(PRSS_SKILL1)}：为${get.translation(trigger.card)}重新指定目标`,
					prompt2: `原目标：${get.translation(trigger.targets)}`,
					// 目标数保持原样 —— 「任意合法目标」改的是对象，不是数量，
					// 这样也不会把【杀】变成能一次打两个（那是武将牌② 之外的另一回事）
					selectTarget: trigger.targets.length,
					filterTarget(card, player2, target) {
						// 官方 olsbwance 用 get.event().getTrigger() 取回被触发的 useCardToPlayer，
						// 这里跟着用同一套，并以闭包 trigger 兜底（见 prssTriggerOf）
						const evt = prssTriggerOf(trigger);
						return prssTargetEnabled(evt.card, evt.player, target);
					},
					// 至少要换掉一个，否则这次发动没有意义
					filterOk() {
						const evt = prssTriggerOf(trigger);
						return ui.selected.targets.some(target => !evt.targets.includes(target));
					},
					// AI：只看「这张牌打在目标身上对我好不好」，越大越值得选
					ai(target) {
						const evt = prssTriggerOf(trigger);
						return get.effect(target, evt.card, evt.player, player);
					},
				})
				.forResult();
		},
		async content(event, trigger, player) {
			const targets = (event.targets || []).slice(0).sortBySeat();
			if (!targets.length) {
				return;
			}
			// 三处一起改，缺一不可（照官方 olsbwance 的 effect 子技能）：
			//   trigger.targets              —— useCardToPlayer 自己的目标表
			//   trigger.getParent().targets  —— useCard 事件的目标表，后续结算按它走
			//   triggeredTargets1            —— useCard 用它记录「哪些目标已经触发过
			//                                   useCardToPlayer」，重置后新目标才会被逐个触发；
			//                                   而 event.isFirstTarget1 不会被重置，
			//                                   所以新目标带来的第二轮触发不会再问一次本技能（天然防递归）
			trigger.targets = targets;
			const parent = trigger.getParent();
			if (parent) {
				parent.targets = targets;
				parent.triggeredTargets1 = targets;
			}
			game.log(targets, "成为了", trigger.card, "的新目标");
		},
		// 觉醒那段在描述里不出现（charlotte），所以挂成子技能
		group: ["prss_gaixie_juexing"],
		subSkill: {
			// ── 觉醒技：死亡前更换武将牌（①→②）──────────────────
			// 与结城理【面具】的 die 子技能同一套（理由见 jyclDieMask 的注释）：
			// 时机必须是 dieBefore，不能是 die —— 挂在 die 上时判死那几步早就做完了，
			// 即便在 die 里复活成功，看上去也还是「直接死了」。
			// dieBefore 由 gameEvent 的 loop() 在 content 之前触发且是 await 的，
			// 这里 cancel() 之后整段死亡 content 一个 step 都不会执行。
			juexing: {
				audio: false,
				// 内部技能，不出现在武将牌的技能栏里（描述上只有一个空白技能）
				charlotte: true,
				trigger: { player: "dieBefore" },
				// 不弹确认框直接结算；direct / priority 对着结城理那套配
				forced: true,
				forceDie: true,
				direct: true,
				priority: 15,
				filter(event, player) {
					return player.name1 == "prss_priestess1" || player.name2 == "prss_priestess1";
				},
				async content(event, trigger, player) {
					// 拦掉整段死亡流程：不移入 game.dead、不隐藏界面、不弃手牌、不挂死亡按钮
					trigger.cancel();
					// cancel() 之后没人再把体力从 0 拉回来，得自己复活（同步函数且幂等）
					player.revive(1, false);
					// 换牌后体力保持这 1 点，不额外回满（见 prssSwapCard 注释）
					await prssSwapCard(player, "prss_priestess2");
					// 进入二阶段时抽三张牌。
					// ★ 放在换牌**之后**：这时武将牌② 的技能已经挂上，
					//   这三张会经过 prss_tihuan_all 的 drawBegin —— 对自己抽牌换走「无价值」的牌，
					//   所以实际摸到的会比表面略好一点。这是规则的自然结果，不是额外补偿。
					await player.draw(3);
				},
			},
		},
	},

	// ── 武将牌② 的主技能 ────────────────────────────────────────
	// 五段能力都挂在这一个技能名下（group + subSkill，与「面具」同一套写法）：
	//   【替牌·人】其他角色抽牌前，读取牌堆顶 num 张，把其中有价值的牌洗回牌堆，重复至多 6 次
	//   【替牌·眼】其他角色的手牌始终对你可见（同孙悟空【金睛】）
	//   【替牌·己】其他角色 / 你抽牌前，对别人换走有价值的、对自己换走无价值的，重复至多 3 次
	//   【替牌·换】需要使用/打出牌时、或出牌阶段，可以把一张手牌与**牌堆**里的一张牌互换
	//              （与另一处换牌是**同一套结算**，连界面文案都共用一份）
	prss_tihuan: {
		audio: false,
		// 「其他角色的手牌始终对你可见」= 孙悟空【金睛】的写法。
		//   引擎渲染手牌时问的是 game.me.hasSkillTag("viewHandcard", null, node, true)
		//   （get/index.js、card.js、content.js 三处都这么判），而 hasSkillTag 会遍历
		//   getSkills() + expandSkills() 之后的 ai 字段（player.js:13303）。
		//   skillTagFilter 里 player == arg 时返回 false —— 自己看自己不算「别人」，
		//   不挡的话等于把自己的手牌也标成"可见"，虽然没差别，但语义上不该过。
		//
		//   ★ 放在主技能（而不是子技能）上：主技能一定在 player.skills 里，
		//     不依赖 group 展开，手牌可见这件事必须是稳的。
		ai: {
			viewHandcard: true,
			skillTagFilter(player, tag, arg) {
				if (player == arg) {
					return false;
				}
			},
		},
		group: ["prss_tihuan_foe", "prss_tihuan_all", "prss_tihuan_use", "prss_tihuan_phase"],
		subSkill: {
			// ── ① 其他角色抽牌前：把「有价值」的牌换走（至多 6 次）──
			foe: {
				// ── 隐形四件套（与另一处换牌的锁定子技能同一套）────────
				// charlotte：不进技能栏（getStockSkills 会把 charlotte 从展示列表剔除）
				charlotte: true,
				// direct：不弹「是否发动」确认框（content.js 的 createTrigger：
				//   forced / direct 都会直接给出 { bool: true }，只有两者都没有才 chooseBool）
				direct: true,
				// log / logv：不写战报
				log: false,
				logv: false,
				// audio：不播语音（没有素材，也不该暴露）
				audio: false,
				// 锁定技 + 自动发动
				locked: true,
				forced: true,
				// 时机理由见「抽牌前换牌」那段：
				// drawBegin 时 event.num 才是最终值（drawTo / 各种「摸牌数 +X」的 mod 都写过了）
				trigger: { global: "drawBegin" },
				filter(event, player) {
					// 只管别人抽牌；自己抽牌交给下面 all 那段
					if (event.player == player) {
						return false;
					}
					// 从牌堆底摸的牌（draw(..., "bottom")）不在牌堆顶，洗顶部没有意义
					if (event.bottom) {
						return false;
					}
					return (event.num | 0) > 0;
				},
				async content(event, trigger, player) {
					const num = Math.max(0, trigger.num | 0);
					if (num <= 0) {
						return;
					}
					// ★ 用**抽牌者**的体力判断杀/闪有没有价值：
					//   要换掉的是"这个人马上要摸到的牌"，标准自然按他算
					prssSweepTop(trigger.player, num, 6, pileCardIsValuable);
				},
			},
			// ── ② 任何角色抽牌前：对别人换有价值的、对自己换无价值的（至多 3 次）──
			all: {
				charlotte: true,
				direct: true,
				log: false,
				logv: false,
				audio: false,
				locked: true,
				forced: true,
				trigger: { global: "drawBegin" },
				filter(event, player) {
					if (event.bottom) {
						return false;
					}
					return (event.num | 0) > 0;
				},
				async content(event, trigger, player) {
					const drawer = trigger.player;
					const num = Math.max(0, trigger.num | 0);
					if (num <= 0) {
						return;
					}
					// 看对象决定换哪一类：别人抽牌时换走好东西（削弱对方），
					// 自己抽牌时换走没用的东西（优化自己的手牌）。
					// 价值标准共用 pileCardIsValuable。
					const precious = drawer != player;
					prssSweepTop(drawer, num, 3, (card, owner) =>
						precious ? pileCardIsValuable(card, owner) : !pileCardIsValuable(card, owner)
					);
				},
			},
			// ── ③ 换牌：需要使用或打出牌时 ──────────────────────────
			// 与另一处换牌是**同一套结算**（pileSwapContent），
			// 连界面文案都共用一份；差别只有防重入标记的名字。
			//
			// ★ 为什么用触发技而不是 `enable: "chooseToUse"` 的主动技：
			//   主动技走 chooseToUse 时，引擎在选定技能后会去拿 info.viewAs 造一张牌来使用；
			//   没有 viewAs 就没有牌可出，是条死路（除非像杜预那样走 chooseButton + backup）。
			//   而本技能的效果是"拿一张牌区的牌换出一张手牌"，**根本不产出牌**，
			//   属于纯资源操作 —— 用触发技在选牌开始时插一段才是不绕远路的写法。
			//   这个时机在库里是标准用法：官方【八卦阵】就是
			//   trigger: { player: ["chooseToRespondBegin", "chooseToUseBegin"] }。
			use: {
				charlotte: true,
				audio: false,
				log: false,
				logv: false,
				// direct: true = **不弹「是否发动」确认框**，直接进 content 的选牌界面。
				// （引擎 content.js 的 createTrigger：forced / direct 都会直接给出
				//   { bool: true }，只有两者都没有才 chooseBool。）
				// ⚠ direct **不会**影响 content 内部 chooseCard / chooseButton 是否弹界面：
				//   那两个事件各有自己的 direct 字段，技能上的 direct 管的是"技能要不要确认"。
				// 也不写 forced —— 描述是「你可以」，而且 forced 会抢掉这次出牌的确认。
				direct: true,
				trigger: { player: ["chooseToUseBegin", "chooseToRespondBegin"] },
				filter(event, player) {
					// 已经有人响应过（比如别人已经出过牌）就不用再插一脚
					if (event.responded) {
						return false;
					}
					// ★ 防重入：content 里会调 chooseCard / chooseButton，
					//   那两个事件自己也会触发 chooseToUseBegin，不拦就会无限递归
					if (event.prss_swap_use) {
						return false;
					}
					return pileSwapReady(player);
				},
				content: prssSwapUseContent,
			},
			// ── ④ 换牌：出牌阶段 ────────────────────────────────────
			phase: {
				charlotte: true,
				audio: false,
				log: false,
				logv: false,
				// 同 use：不询问，直接进 content 的选牌界面
				direct: true,
				trigger: { player: "phaseUseBegin" },
				filter(event, player) {
					if (event.prss_swap_phase) {
						return false;
					}
					return pileSwapReady(player);
				},
				content: prssSwapPhaseContent,
			},
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 瓦伦西娜（蜀 / 4体力）
	//
	// 三个技能围绕「造成伤害」这一件事展开：
	//   怒枪  每回合的第 1 次伤害 +1    → 把第一击抬起来
	//   震颤  造成伤害后按伤害值存标记  → 攒够三枚换一次翻面 + 摸三张
	//   处置  限定技，全体翻面 + 摸满 + 本回合无视距离与次数
	//
	// 三者天然连成一条线：怒枪抬高第一击 → 震颤因此多存一点 →
	// 处置再把攒下来的节奏一次性兑现成整轮先手。
	// ══════════════════════════════════════════════════════════════

	// ── 怒枪 ─────────────────────────────────────────────────────
	// 描述：锁定技，每回合你造成的第1次伤害+1。
	wlnx_nuqiang: {
		// 没有语音素材，关掉音频查找（audio: false 的技能不会被 trySkillAudio 找到文件）
		audio: false,
		locked: true,
		forced: true,
		// damageBegin1：伤害结算的第一步，此时改 trigger.num 还来得及
		// （黎明的【杀】伤害+1 用的是同一个时机）
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			// unreal（视为造成伤害，例如维什戴尔【魂影】）不实际扣体力，
			// 既不该被 +1，也不该占用「本回合第 1 次」的名额
			if (event.unreal || event.num <= 0) {
				return false;
			}
			// ★ 这里不能照抄【余震】的 indexOf(event) 写法。
			//   余震挂在 damageSource（伤害结算结束），那时本次事件**已经**写进
			//   sourceDamage 历史，所以用「下标 > 0」表示「此前已经造成过伤害」。
			//   而 damageBegin1 是结算的**开始**，引擎要到 damageBegin4 之后才 push：
			//       source.getHistory("sourceDamage").push(event);   // content.js
			//   此刻事件还没进历史，所以「历史里没有真实伤害」就等于「这是第 1 次」。
			//   另外 getHistory 读的是每个角色自己的 actionHistory，
			//   引擎每回合会给所有角色各 push 一条，所以在别人的回合里也成立。
			return player.getHistory("sourceDamage", evt => !evt.unreal && evt.num > 0).length == 0;
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},

	// ── 震颤 ─────────────────────────────────────────────────────
	// 描述：锁定技，当你造成伤害后，你获得等同于此次伤害值的“震颤”标记。
	//       出牌阶段，你可以弃置三张“震颤”，令一名角色翻面，然后你摸三张牌。
	//
	// 一个技能同时有两种身份（被动锁定技 + 出牌阶段主动技），按本扩展的惯例
	// 拆成「主技能带 enable、再用 group 指到子技能」：主动那半留在这里，
	// 锁定那半交给 wlnx_zhenchan_gain。
	wlnx_zhenchan: {
		audio: false,
		// 主动技：出牌阶段点一下发动，没有 filterCard / selectCard，不选牌
		enable: "phaseUse",
		filter(event, player) {
			return player.countMark("wlnx_zhenchan_mark") >= 3;
		},
		async content(event, trigger, player) {
			// chooseTarget 的对象写法（player.js 的 chooseTarget 支持），
			// selectTarget 传数字会被自动补成 [n, n]。
			const result = await player
				.chooseTarget({
					prompt: "震颤：弃置三张“震颤”，令一名角色翻面",
					selectTarget: 1,
					forced: true,
					// 翻面对目标是负收益，取负号后得分最高的是「最不友好」的那个。
					// 自己对自己 attitude 为正，取负号后是负数，AI 不会拿自己翻面。
					ai(target) {
						return -get.attitude(player, target);
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			const target = result.targets[0];
			// 弃置三张“震颤”——弃的是**标记**而不是牌，所以走 removeMark
			player.removeMark("wlnx_zhenchan_mark", 3);
			player.line(target, "green");
			// turnOver(true) = 翻至背面；已是背面的角色会直接跳过这次结算
			// （player.js 的 turnOver 在传了 bool 时会先判一次状态），
			// 所以不会把已经翻面的人反着翻回正面
			await target.turnOver(true);
			await player.draw(3);
		},
		group: ["wlnx_zhenchan_gain"],
		ai: {
			order: 10,
			result: { player: 1 },
		},
	},
	// 震颤的锁定技那半：造成伤害后按伤害值累加「震颤」标记
	wlnx_zhenchan_gain: {
		audio: false,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		charlotte: true,
		sourceSkill: "wlnx_zhenchan",
		// damageSource：伤害结算结束后，以「伤害来源是自己」的身份触发
		// （event.player 是受伤角色，event.num 是本次伤害值）
		trigger: { source: "damageSource" },
		filter(event, player) {
			return event.num > 0;
		},
		async content(event, trigger, player) {
			player.addMark("wlnx_zhenchan_mark", trigger.num);
		},
	},
	// 「震颤」标记的容器技能。
	// addMark / removeMark 内部会自己调用 markSkill / unmarkSkill，
	// 而 markSkill 只要求 lib.skill[标记名].intro 存在就能把标记渲染出来，
	// 所以这个技能不需要 addSkill 给任何角色（与遥的「浮泡」同一套做法），
	// 也因此不进 wlnx_zhenchan 的 group。
	wlnx_zhenchan_mark: {
		audio: false,
		charlotte: true,
		mark: true,
		marktext: "震颤",
		intro: {
			name: "震颤",
			content: "锁定技，当你造成伤害后，你获得等同于此次伤害值的“震颤”标记。出牌阶段，你可以弃置三张“震颤”，令一名角色翻面，然后你摸三张牌。",
		},
	},

	// ── 处置 ─────────────────────────────────────────────────────
	// 描述：限定技，出牌阶段，你可以令所有其他角色翻面，
	//       然后你摸等同于场上角色数的牌；本回合你使用牌无距离和次数限制。
	wlnx_chuzhi: {
		audio: false,
		enable: "phaseUse",
		limited: true,
		skillAnimation: true,
		animationColor: "orange",
		// 「发动过就不能再发动」由引擎按 limited + awakenSkill 处理，不用自己判。
		// 这里只挡「场上已经没有能翻面的对象」的情况（全是背面时点了也白点）。
		filter(event, player) {
			return game.hasPlayer(current => current != player && !current.isTurnedOver());
		},
		async content(event, trigger, player) {
			// 限定技的固定写法：标记为已发动
			player.awakenSkill(event.name);
			// 所有其他角色翻面。turnOver(true) 对已是背面的角色是空操作，
			// 所以不必自己先筛一遍 isTurnedOver
			for (const current of game.filterPlayer(current => current != player)) {
				await current.turnOver(true);
			}
			// 摸等同于场上角色数的牌（game.players 只含存活角色，且包含自己）
			await player.draw(game.players.length);
			// 本回合使用牌无距离和次数限制。
			// addTempSkill 的 expire 写成 { player: 时机名 } 表示
			// 「你自己的这个时机到来时移除」，phaseAfter = 整个回合结束之后，
			// 所以本回合内一直有效。
			player.addTempSkill("wlnx_chuzhi_buff", { player: "phaseAfter" });
		},
		ai: {
			order: 10,
			result: { player: 1 },
		},
	},
	// 处置给的「无距离、无次数」状态：纯 mod，charlotte 不显示
	wlnx_chuzhi_buff: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		mod: {
			// 无距离限制：任何牌都能指定任何角色
			// （返回 true 即「在我的攻击范围内」）
			targetInRange(card, player, target) {
				return true;
			},
			// 无次数限制：引擎的判定是 player.countUsed(card) < num
			// （见 library/index.js 的 lib.filter.cardUsable），返回 Infinity 恒成立。
			// 注意必须返回 number —— 返回非 number 会被引擎当成 boolean 直接取用。
			cardUsable(card, player, num) {
				return Infinity;
			},
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 夕（群 / 3体力）
	//
	// 三个技能围绕「魉」这一个召唤单位转：墨魎 造它、丹青 用它、写意 送它。
	//
	// 「魉」在引擎层面是**真玩家**（addPlayerOL 插进座位表），所以那些特殊规则
	// 不是改数据，而是一条条落到它身上的真实机制：
	//   · 没有装备区：await liang.disableEquip(1, 2, 3, 4, 5)
	//   · 没有判定区：liang.storage._disableJudge = true
	//     （两者都是引擎内建的「废除区域」，见 player.js 的
	//       countDisabledSlot / isDisabledJudge）
	//   · 摸牌阶段不摸牌：给它 dx_liang_nodraw，在 phaseDrawBegin 里把 num 改成 0
	//   · 陷入濒死后立即死亡：给它 dx_liang_die，在 dying 时机打 skipTao
	//     （content.js 的 dying 流程里是 `else if (!event.skipTao)` 才走求桃）
	//   · 回合由夕操控：_trueMe + 全局技能 autoswap（与单机「操作队友」同一套）
	// ══════════════════════════════════════════════════════════════

	// ── 墨魎 ─────────────────────────────────────────────────────
	// 描述：每轮限一次，轮次开始时，你可以弃置一张♣牌，将其置于你与上家或
	//       下家之间，称为「魉」。（它自身的规则见 translate.js）
	dx_moliang: {
		audio: false,
		// roundStart 每轮只来一次，「每轮限一次」不需要另外计数
		trigger: { global: "roundStart" },
		filter(event, player) {
			// 已经有魉就不能再放 —— 这一条同时也就实现了
			// 「不可在你与魉之间放置魉」
			if (dxLiangOf(player)) {
				return false;
			}
			return player.countCards("h", card => get.suit(card) == "club") > 0;
		},
		async content(event, trigger, player) {
			const result = await player
				.chooseCard("h", "墨魎：弃置一张♣牌，置于你与上家或下家之间", card => get.suit(card) == "club")
				.forResult();
			if (!result.bool) {
				return;
			}
			const card = result.cards[0];
			// 先问方向再落子：点取消就整件事不发生（牌也不弃）
			const side = await player
				.chooseControl("上家", "下家")
				.set("prompt", "墨魎：把「魉」放在你的哪一侧？")
				.set("ai", () => ["上家", "下家"].randomGet())
				.forResult();
			if (side.index == null) {
				return;
			}
			await player.discard(card);
			// isNext = false 插上家、true 插下家（座位计算见 game/index.js 的 addPlayerOL）
			const liang = await game.addPlayerOL(player, DX_LIANG, null, side.index == 1, { source: player });
			if (!liang) {
				return;
			}
			// ① 没有装备区：废除全部五个装备槽
			await liang.disableEquip(1, 2, 3, 4, 5);
			// ② 没有判定区
			liang.storage._disableJudge = true;
			// ③④⑤ 不摸牌 / 濒死即死 / 死后让夕摸一张（规则写在它自己的技能里）
			// ⑦ 死后从座位表退场（见 dx_liang_clean）
			// ⑨ AI 别盯着它打（见 dx_liang_ai）
			liang.addSkill(["dx_liang_nodraw", "dx_liang_die", "dx_liang_dieafter", "dx_liang_clean", "dx_liang_ai"]);
			// ⑨ 再把 AI 对它的态度压到「中立」：光有 zerotarget 还不够 ——
			//    态度是负数的话，AI 仍会把它当成「值得打的敌人」来排队。
			liang.ai = liang.ai || {};
			liang.ai.modAttitudeTo = (from, to, att) => Math.max(att, 0);
			// ⑥ 回合由夕操控
			liang._trueMe = player;
			// ⑧ ★ 中立单位：不参与任何胜负判定。
			//
			//   单挑模式（mode/single.js）给 lib.element.player 挂了一个 dieAfter
			//   钩子，**任何**角色死亡都会跑一次 game.checkResult()；而
			//   game.removePlayerOL 的结尾又会补一次 player.dieAfter()。
			//   魉只是夕画出来的影子，它碎掉不该替夕认输 —— 实例上的同名方法会
			//   盖住原型上的模式补丁，于是这两个钩子对它都是空操作。
			//   （dieAfter2 是单挑模式的「死亡后换将」，同样不该轮到召唤物。）
			liang.dieAfter = () => Promise.resolve();
			liang.dieAfter2 = () => Promise.resolve();
			game.addGlobalSkill("autoswap");
			game.log(player, "画出了", liang);
		},
		ai: {
			order: 1,
			result: { player: 1 },
		},
	},

	// ── 魉的固有规则 ──────────────────────────────────────────────
	// 摸牌阶段不摸牌。用 phaseDrawBegin 把 num 改成 0（阶段本身还在），
	// 而不是 player.skip("phaseDraw") —— 后者会显示「跳过摸牌阶段」，
	// 与「摸牌阶段不摸牌」这句话不是一回事。
	dx_liang_nodraw: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		trigger: { player: "phaseDrawBegin" },
		async content(event, trigger, player) {
			trigger.num = 0;
		},
	},
	// 陷入濒死后立即死亡：跳过求桃流程。
	// ★ content.js 的 dying 流程里，只有 `!event.skipTao` 时才进入 _save（求桃），
	//   所以给 dying 事件打上 skipTao 就等于「没人能救、直接死」。
	// 顺手把操控者记进 storage：写意要在 dieAfter 里用它，而那时 _trueMe 未必还在。
	dx_liang_die: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		trigger: { player: "dying" },
		async content(event, trigger, player) {
			trigger.skipTao = true;
			player.storage.dx_liang_owner = player._trueMe || null;
		},
	},
	// 魉死亡后：让操控者摸一张牌（「并让你摸一张牌」）
	dx_liang_dieafter: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		trigger: { player: "dieAfter" },
		async content(event, trigger, player) {
			const owner = player.storage.dx_liang_owner;
			if (owner && owner.isIn()) {
				await owner.draw(1);
			}
		},
	},
	// 「魉」碎掉之后从座位表里彻底退场 —— 它本来就只是一张画，不该留一具尸体
	// 占着座位、算进人数，或者被别的技能当成「场上的一名角色」。
	//
	// ★ 用 global 而不是 player：写意（dx_xieyi）要在同一个时机收尾，
	//   而 player 类的触发一定排在 global 类前面，那样会先把牌和座位都撤掉。
	//   同为 global 时按 priority 从大到小排序（gameEvent.js 的 sort），
	//   写意是 0，这里是 -1 * 100 + silent 的 1 = -99，所以写意先跑完。
	dx_liang_clean: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		priority: -1,
		trigger: { global: "dieAfter" },
		filter(event, player) {
			return event.player == player && player.name == DX_LIANG;
		},
		async content(event, trigger, player) {
			// animate: false —— 死亡动画在 die 里已经放过了，这里只要干脆地消失
			await game.removePlayerOL(player, { animate: false });
		},
	},

	// ★「魉」不是给人打的。
	//
	// 它没有装备区、没有判定区、手牌也留不住，打它一点收益都没有 ——
	// 可它在引擎眼里就是「场上的一名角色」，AI 会顺手把它排进目标里。
	//
	// get.effect 在算「对某人使用这张牌」时，会去问**目标**的技能
	// （get/index.js 里的 `temp2.effect.target(card, player, target, result2)`），
	// 返回字符串 "zerotarget" 就把「对它的效果」直接归零。
	// 态度那一半写在 dx_moliang 里（liang.ai.modAttitudeTo）。
	dx_liang_ai: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dx_moliang",
		ai: {
			effect: {
				target(card, player, target) {
					return "zerotarget";
				},
			},
		},
	},

	// ── 丹青（转换技）────────────────────────────────────────────
	// 描述：转换技，出牌阶段限一次。
	//   ①入画：交给「魉」一张手牌，若为黑色，你摸一张牌，然后你与其他角色计算距离+1。
	//   ②创物：将一张黑色锦囊牌当作【五谷丰登】使用。若如此做，直到本轮结束时，
	//          其余角色不能对你或「魉」使用伤害类锦囊牌。
	dx_danqing: {
		audio: false,
		// 转换技三件套（与初雪【祈愿】同一套）：zhuanhuanji 开关 + mark + intro
		zhuanhuanji: true,
		mark: true,
		marktext: "丹",
		intro: {
			// storage 就是 player.storage.dx_danqing：假 = ①，真 = ②
			content(storage, player) {
				return !storage
					? "出牌阶段限一次，你可以交给「魉」一张手牌。若此牌为黑色，你摸一张牌，然后你与其他角色计算距离+1。"
					: "出牌阶段限一次，你可以将一张黑色锦囊牌当作【五谷丰登】使用。若如此做，直到本轮结束时，其余角色不能对你或「魉」使用伤害类锦囊牌。";
			},
		},
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			if (!player.storage.dx_danqing) {
				// ①入画：既要有魉，也要有牌可给
				return !!dxLiangOf(player) && player.countCards("h") > 0;
			}
			// ②创物：要有黑色锦囊牌
			return player.countCards("h", dxIsBlackTrickCard) > 0;
		},
		async content(event, trigger, player) {
			if (!player.storage.dx_danqing) {
				// ①入画
				const liang = dxLiangOf(player);
				const result = await player.chooseCard("h", "丹青·入画：交给「魉」一张手牌").forResult();
				if (!result.bool) {
					return;
				}
				const card = result.cards[0];
				const black = get.color(card) == "black";
				await player.give(card, liang);
				if (black) {
					await player.draw(1);
					// 「你与其他角色计算距离+1」按 globalTo 实现（别人 → 夕 +1）。
					// 注意别和 globalFrom 写反：globalFrom 修饰的是「自己 → 别人」
					// （【马术】【霜涛】用的是 globalFrom；初雪【圣山】的
					//  「其他角色计算与你的距离+1」与这里同向，用的也是 globalTo）。
					player.addTempSkill("dx_danqing_dist", "roundEnd");
				}
			} else {
				// ②创物
				const result = await player.chooseCard("h", "丹青·创物：将一张黑色锦囊牌当作【五谷丰登】使用", dxIsBlackTrickCard).forResult();
				if (!result.bool) {
					return;
				}
				const card = result.cards[0];
				await player.chooseUseTarget({
					card: get.autoViewAs({ name: "wugu" }, [card]),
					forced: true,
					addCount: false,
				});
				// 直到本轮结束：自己与魉都免疫伤害类锦囊
				player.addTempSkill("dx_danqing_guard", "roundEnd");
				const liang = dxLiangOf(player);
				if (liang) {
					liang.addTempSkill("dx_danqing_guard", "roundEnd");
				}
			}
			player.changeZhuanhuanji(event.name);
		},
		ai: {
			order: 7,
			result: { player: 1 },
		},
	},
	// 入画给的距离修正：别人 → 夕 +1（也就是其他人更难够到她）
	dx_danqing_dist: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		mod: {
			// globalTo 修饰「别人 → 自己」的距离（与初雪【圣山】同一个字段）
			globalTo(from, to, distance) {
				return distance + 1;
			},
		},
	},
	// 创物的保护：其余角色不能对「本技能拥有者」使用伤害类锦囊。
	// 这个技能会被同时挂到夕和魉身上，各管各的。
	dx_danqing_guard: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		mod: {
			// target 就是本技能的拥有者
			targetEnabled(card, player, target) {
				if (player == target) {
					return;
				}
				if (!dxIsDamagingTrick(card)) {
					return;
				}
				return false;
			},
		},
	},

	// ── 写意（限定技）────────────────────────────────────────────
	// 描述：限定技，当「魉」死亡时，你可以弃置至少两张黑色牌，
	//       然后移动场上任意区域内的等量张牌。
	dx_xieyi: {
		audio: false,
		limited: true,
		skillAnimation: true,
		animationColor: "gray",
		// 「魉死亡时」挂在 dieAfter 而不是 die：die 还没结算完，
		// 此时去 moveCard 会和死亡善后打架
		trigger: { global: "dieAfter" },
		filter(event, player) {
			if (!event.player || event.player.name != DX_LIANG) {
				return false;
			}
			// 归属判断优先用死亡时记下的 owner（见 dx_liang_die），
			// _trueMe 在 dieAfter 阶段未必还在
			const owner = event.player.storage.dx_liang_owner || event.player._trueMe;
			if (owner != player) {
				return false;
			}
			return player.countCards("he", card => get.color(card) == "black") >= 2;
		},
		async content(event, trigger, player) {
			player.awakenSkill(event.name);
			const result = await player
				.chooseCard("he", [2, Infinity], "写意：弃置至少两张黑色牌，然后移动等量张牌", card => get.color(card) == "black")
				.forResult();
			if (!result.bool) {
				return;
			}
			const cards = result.cards;
			const num = cards.length;
			await player.discard(cards);
			// 移动等量张牌：moveCard 一次只移动一张（它内部是 chooseTarget(2)），所以循环
			for (let i = 0; i < num; i++) {
				const move = await player.moveCard(true).forResult();
				if (!move || !move.bool) {
					break;
				}
			}
		},
		ai: {
			order: 1,
			result: { player: 1 },
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 蓬莱山辉夜 · 神宝
	//
	// 十张「神宝」是**装备/宝物**牌（subtype: "equip5"），定义在 character/card.js。
	// 辉夜自己只有三个技能（初月 / 难题 / 写意级的衍生技），其余全是觉醒链上
	// 一步步"长"出来的：
	//
	//     初月（≥1件）──┬─→ 待宵（≥2件）─→ 朝靄（≥3件）─→ 拂晓（≥4件）
	//                   │                                      │
	//                   │                                      ↓
	//                   │                          永夜归反 -破晓明星-（≥5件）
	//                   │                                      │
	//                   ↓                                      ↓
	//                 永远 / 须臾                      永夜归反 -世间开明-
	//
	// 五个觉醒技是同一条链上的五步，共用 kgyAwakenSkill 这个工厂；
	// 每次觉醒都会「回 1 点体力 + 挑一件神宝升级」。
	// ══════════════════════════════════════════════════════════════

	// ── 难题（锁定技）────────────────────────────────────────────
	// 描述：锁定技，「神宝」离开你的区域时，将其移至你的手牌区；
	//       其他角色不能使用、打出或弃置「神宝」；
	//       其他角色的手牌上限 -X（X 为其拥有的「神宝」数量）；
	//       其他角色的出牌阶段，其可以将一张「神宝」移入你的手牌区，
	//       其与你获得 1 点护甲，你回复 1 点体力；
	//       游戏开始时，将五张「神宝」洗入抽牌堆。
	//
	// 一个技能里塞了三种身份，所以拆成三块：
	//   kgy_nanti       挂在辉夜技能栏上的本体（开局洗牌 + 提升全局规则）
	//   kgy_nanti_keep  神宝的回收规则，靠 group 跟着本体生效
	//   kgy_nanti_rule  **影响其他角色**的那几条，必须是全局技能
	kgy_nanti: {
		audio: false,
		locked: true,
		forced: true,
		group: ["kgy_nanti_keep", "kgy_nanti_gather"],
		trigger: { global: "gameStart" },
		// 技能一到手就把全局规则提升上去。
		// main/content.js 里还有一处同样的调用（扩展加载时就注册），双保险；
		// addGlobalSkill 是幂等的。
		init(player) {
			game.addGlobalSkill(KGY_RULE);
		},
		async content(event, trigger, player) {
			const pile = ui.cardPile;
			if (!pile) {
				return;
			}
			for (const name of KGY_SHENBAO_BASE) {
				// createCard2 而不是 createCard：后者会给牌打上 storage.vanish
				// （「从虚空中来」），进牌堆的牌不能带这个标记
				const card = game.createCard2(name, ["spade", "heart", "club", "diamond"].randomGet(), get.rand(1, 13));
				// 「洗入牌堆」= 插到随机位置。boss 模式里往牌堆塞牌用的也是这一手。
				const count = pile.childElementCount;
				if (count > 0) {
					pile.insertBefore(card, pile.childNodes[get.rand(0, count - 1)]);
				} else {
					pile.appendChild(card);
				}
			}
			game.log(player, "将五张「神宝」洗入了牌堆");
		},
	},

	// ── 难题：神宝的回收规则 ──────────────────────────────────────
	kgy_nanti_keep: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "kgy_nanti",
		// loseAfter 是自己丢牌；loseAsyncAfter 是联机下由别人操作导致的丢牌
		trigger: { player: "loseAfter", global: "loseAsyncAfter" },
		filter(event, player) {
			const lost = kgyLostToRecover(event, player);
			// ① 失去装备区里的火鼠的皮衣 / 火蜥蜴之盾 → 要回血
			if (player.isDamaged() && lost.equip.some(item => item.name == "kgy_piyi" || item.name == "kgy_huoxiyi")) {
				return true;
			}
			// ② 已经不在辉夜身上的神宝 → 要拉回手牌。
			//    这里就把「还在自己身上」的排掉，免得同一次失去被处理两遍
			return lost.all.some(item => get.owner(item.card) != player);
		},
		async content(event, trigger, player) {
			const lost = kgyLostToRecover(trigger, player);
			// ① 失去**装备区里**的火鼠的皮衣 / 火蜥蜴之盾 → 回复 1 点体力
			if (player.isDamaged() && lost.equip.some(item => item.name == "kgy_piyi" || item.name == "kgy_huoxiyi")) {
				await player.recover(1);
			}
			// ② 神宝离开辉夜的区域 → 全部拉回手牌（弃牌堆、别人手里都算）
			const back = lost.all.map(item => item.card).filter(card => get.owner(card) != player);
			if (back.length) {
				await player.gain(back, "gain2");
			}
		},
	},

	// ── 难题：每局一次的「收宝」──────────────────────────────────
	// 描述：每局游戏限一次，出牌阶段开始时，你选择一张「神宝」移入手牌
	//       —— **无论其在何处**。
	//
	// 「无论其在何处」是这条效果的分量所在：那张牌可能还躺在牌堆里（开局洗进去的
	// 五张没人摸到）、在弃牌堆、在处理区、在别人手上，也可能正被辉夜自己装备着。
	// kgyAllShenbao 会把所有这些容器翻一遍，列出来的就是**当前真实存在**的神宝，
	// 玩家选哪张、那张现在在哪，都不需要知道 —— gain 会把它从原处摘出来。
	//
	// ★ 这条做成了「可以不发动」（没有 forced）：「每局限一次」是个要攒着的资源，
	//   强制的话第一个出牌阶段就会被消耗掉（那时场上多半只有自己装备区那几张）。
	//   要改成强制，加一个 forced: true 即可 —— 引擎对非强制技能会先问
	//   「是否发动【难题】」，答否不算发动，也就不消耗这一次。
	kgy_nanti_gather: {
		audio: false,
		charlotte: true,
		sourceSkill: "kgy_nanti",
		trigger: { player: "phaseUseBegin" },
		filter(event, player) {
			// 每局游戏限一次
			if (player.storage.kgy_nanti_gather) {
				return false;
			}
			return kgyAllShenbao().length > 0;
		},
		async content(event, trigger, player) {
			const cards = kgyAllShenbao();
			if (!cards.length) {
				return;
			}
			const result = await player
				.chooseCardButton(cards, "难题：选择一张「神宝」移入你的手牌")
				.forResult();
			if (!result.bool) {
				return;
			}
			// 记账放在「真的选了一张」之后：在引擎那声「是否发动【难题】」上答"是"、
			// 又在这个选择框里点取消的话，这一次不该算用掉。
			player.storage.kgy_nanti_gather = true;
			const card = result.links[0];
			// gain 会自动把它从原来的容器里摘出来 —— 牌堆、弃牌堆、处理区、
			// 别人的手牌、别人的装备区都行
			await player.gain(card, "gain2");
			game.log(player, "将", card, "移入了手牌");
		},
	},

	// ── 难题：针对其他角色的那几条（全局技能）────────────────────
	// 为什么必须是全局的：cardEnabled2 / cardDiscardable / canBeDiscarded / maxHandcard
	// 最后都走 game.checkMod(..., <技能拥有者>)，而「技能拥有者」是**正在行动的那个人**
	// （见 library/index.js 的 lib.filter）。挂到辉夜身上封不住别人 ——
	// 与逻各斯的 lgs_tiyu_seal 是同一个道理，注册点也照它那样放两处。
	kgy_nanti_rule: {
		audio: false,
		charlotte: true,
		// 其他角色的出牌阶段，可以把手里/装备区的神宝"还"给辉夜
		enable: "phaseUse",
		filter(event, player) {
			if (kgyIsOwner(player)) {
				return false;
			}
			if (!kgyOwner()) {
				return false;
			}
			return kgyShenbaoOf(player).length > 0;
		},
		async content(event, trigger, player) {
			const owner = kgyOwner();
			if (!owner) {
				return;
			}
			const result = await player
				.chooseCardButton(kgyShenbaoOf(player), `难题：将一张「神宝」移入${get.translation(owner)}的手牌区`)
				.forResult();
			if (!result.bool) {
				return;
			}
			const card = result.links[0];
			await owner.gain(card, "gain2");
			await player.changeHujia(1);
			await owner.changeHujia(1);
			await owner.recover(1);
			game.log(player, "将", card, "交给了", owner);
		},
		mod: {
			// cardEnabled 和 cardRespondable 都会先查 cardEnabled2，
			// 所以这一条同时封住「使用」和「打出」
			cardEnabled2(card, player) {
				if (!kgyIsShenbao(card) || kgyIsOwner(player) || !kgyActive()) {
					return;
				}
				return false;
			},
			// 自己弃置（出牌阶段的弃牌、各种「弃置一张牌」的代价）
			cardDiscardable(card, player) {
				if (!kgyIsShenbao(card) || kgyIsOwner(player) || !kgyActive()) {
					return;
				}
				return false;
			},
			// 被别人弃置 / 拿走（【过河拆桥】【顺手牵羊】走的都是 canBeDiscarded）。
			// 签名是 (card, player, target)，player 是**动手的人**、target 是牌的持有者。
			canBeDiscarded(card, player) {
				if (!kgyIsShenbao(card) || kgyIsOwner(player) || !kgyActive()) {
					return;
				}
				return false;
			},
			// 其他角色的手牌上限 -X（X 为其拥有的神宝数）
			maxHandcard(player, num) {
				if (kgyIsOwner(player) || !kgyActive()) {
					return num;
				}
				return num - player.countCards("h", kgyIsShenbao);
			},
		},
		ai: {
			// 手里压着神宝是纯亏（手牌上限 -1），还回去还能换 1 点护甲，
			// 所以给 AI 一个正收益让它会用
			order: 1,
			result: { player: 1 },
		},
	},

	// ── 觉醒链（五步）────────────────────────────────────────────
	kgy_chuyue: kgyAwakenSkill({ need: 1, gain: ["kgy_daixiao", "kgy_yongyuan"], color: "orange" }),
	kgy_daixiao: kgyAwakenSkill({ need: 2, gain: ["kgy_zhaoai", "kgy_xuyu"], color: "orange" }),
	kgy_zhaoai: kgyAwakenSkill({ need: 3, gain: ["kgy_fuxiao"], color: "orange" }),
	kgy_fuxiao: kgyAwakenSkill({ need: 4, gain: ["kgy_poxiao"], color: "fire", maxHp: true }),
	kgy_poxiao: kgyAwakenSkill({ need: 5, gain: ["kgy_shijian"], color: "fire", maxHp: true }),

	// ── 永远 ─────────────────────────────────────────────────────
	// 描述：出牌阶段，你可以弃置 3 张牌并指定一名角色，
	//       其下个回合开始时，记录其区域内的牌；
	//       其下个回合结束时，将其区域恢复至记录状态。
	kgy_yongyuan: {
		audio: false,
		enable: "phaseUse",
		filter(event, player) {
			return player.countCards("he") >= 3;
		},
		async content(event, trigger, player) {
			const discard = await player.chooseCard("he", 3, "永远：弃置三张牌").forResult();
			if (!discard.bool) {
				return;
			}
			const result = await player
				.chooseTarget({
					prompt: "永远：指定一名角色，记录其下个回合的区域状态",
					selectTarget: 1,
					forced: true,
					ai(target) {
						return get.attitude(player, target);
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			await player.discard(discard.cards);
			const target = result.targets[0];
			player.line(target, "green");
			target.addSkill("kgy_yongyuan_mark");
			target.storage.kgy_yongyuan_mark = null;
			game.log(player, "对", target, "发动了", "【永远】");
		},
		ai: {
			order: 5,
			result: { player: 1 },
		},
	},
	// 「永远」在目标身上留下的记录/复原钩子。
	// phaseBegin 记快照，phaseEnd 复原 —— 中间隔着整个回合，
	// 所以技能的 filter 靠 storage 里有没有快照来区分这两个时机。
	// ★ 快照就存在 player.storage.kgy_yongyuan_mark（键名 = 技能名）里，
	//   这样下面那句 `onremove: "storage"` 才能在技能被移除时顺手清掉它。
	kgy_yongyuan_mark: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "kgy_yongyuan",
		trigger: { player: ["phaseBegin", "phaseEnd"] },
		filter(event, player, name) {
			// 回合开始：还没有快照就记一份
			if (name == "phaseBegin") {
				return !player.storage.kgy_yongyuan_mark;
			}
			// 回合结束：只有当回合记过快照才复原。
			// （刚被指定的那个回合里 phaseEnd 会先到，那时没有快照，直接跳过，
			//   技能留着等下个回合真正生效。）
			return !!player.storage.kgy_yongyuan_mark;
		},
		async content(event, trigger, player) {
			// ★ 判断「是哪个时机触发的」要用 event.triggername，不能看 trigger.name。
			//   phaseBegin / phaseEnd / phaseAfter 是 phaseLoop 内部用
			//   `event.trigger("phaseBegin")` 发出的**时机名**，不是事件名 ——
			//   trigger 参数拿到的是那个 phaseLoop 事件，它的 name 是 "phaseLoop"。
			//   （独立事件如 damage / die / draw 才轮得到 trigger.name。）
			if (event.triggername == "phaseBegin") {
				player.storage.kgy_yongyuan_mark = player.getCards("hej").slice();
				game.log(player, "的区域被【永远】记录了下来");
				return;
			}
			const snapshot = player.storage.kgy_yongyuan_mark || [];
			player.storage.kgy_yongyuan_mark = null;
			const current = player.getCards("hej");
			// 多出来的牌：直接送进弃牌堆（走 cardsDiscard 就不会再触发一次「失去牌」）
			const extra = current.filter(card => !snapshot.includes(card));
			if (extra.length) {
				await game.cardsDiscard(extra);
			}
			// 少掉的牌：从任何地方拿回来（弃牌堆、别人手里都算）
			const missing = snapshot.filter(card => !current.includes(card) && !!get.position(card));
			if (missing.length) {
				await player.gain(missing, "gain2");
			}
			game.log(player, "的区域被【永远】复原了");
			// 收尾放在最后：removeSkill 会 clearStepCache，虽然 async content
			// 不会被 StepCompiler 重新编译（见本文件里的相关说明），但没必要冒险
			player.removeSkill("kgy_yongyuan_mark");
		},
		// 技能被移除时把快照一起清掉，不留孤儿键
		onremove: "storage",
	},

	// ── 须臾 ─────────────────────────────────────────────────────
	// 描述：出牌阶段，你可以弃置 4 张牌，指定一名角色，
	//       其出牌阶段、弃牌阶段、结束阶段结束时，分别抽 2 / 2 / 1 张牌。
	//
	// ★ 限制是「**每回合每角色限一次**」，不是「出牌阶段限一次」：
	//   一个出牌阶段里可以反复发动（每次弃 4 张牌），
	//   但同一名角色每回合只能被指定一次 —— 所以这里**不设 usable**，
	//   改用 kgyXuyuAvailable 记名单，由 kgy_xuyu_reset 在回合结束时清空。
	// ★ 效果本身仍然按**永久**实现：描述里没写时限，
	//   与【永远】明确写了"其下个回合"不同。
	kgy_xuyu: {
		audio: false,
		enable: "phaseUse",
		filter(event, player) {
			if (player.countCards("he") < 4) {
				return false;
			}
			// 还有没被指定过的角色吗
			return game.hasPlayer(target => kgyXuyuAvailable(player, target));
		},
		async content(event, trigger, player) {
			const discard = await player.chooseCard("he", 4, "须臾：弃置四张牌").forResult();
			if (!discard.bool) {
				return;
			}
			const result = await player
				.chooseTarget({
					prompt: "须臾：指定一名本回合尚未被指定过的角色",
					selectTarget: 1,
					forced: true,
					filterTarget(card, player, target) {
						return kgyXuyuAvailable(player, target);
					},
					ai(target) {
						return get.attitude(player, target);
					},
				})
				.forResult();
			if (!result.bool) {
				return;
			}
			await player.discard(discard.cards);
			const target = result.targets[0];
			kgyXuyuMark(player, target);
			player.line(target, "green");
			target.addSkill("kgy_xuyu_mark");
			game.log(player, "对", target, "发动了", "【须臾】");
		},
		group: ["kgy_xuyu_reset"],
		ai: {
			order: 5,
			result: { player: 1 },
		},
	},
	// 「每回合每角色限一次」的名单在辉夜自己的回合结束时清空。
	// （须臾只可能在辉夜的出牌阶段发动，所以清自己的 phaseEnd 就够。）
	kgy_xuyu_reset: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "kgy_xuyu",
		trigger: { player: "phaseEnd" },
		async content(event, trigger, player) {
			player.storage.kgy_xuyu_targets = [];
		},
	},
	kgy_xuyu_mark: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "kgy_xuyu",
		trigger: { player: ["phaseUseEnd", "phaseDiscardEnd", "phaseJieshuEnd"] },
		async content(event, trigger, player) {
			// 出牌阶段、弃牌阶段结束各抽 2 张；结束阶段结束抽 1 张
			// ★ 分辨时机用 event.triggername：phaseUseEnd / phaseDiscardEnd /
			//   phaseJieshuEnd 都是各阶段内部用 `event.trigger(...)` 发出的时机名，
			//   trigger.name 拿到的是那个阶段事件（"phaseUse" / "phaseDiscard" /
			//   "phaseJieshu"），永远不等于 "phaseJieshuEnd"。
			await player.draw(event.triggername == "phaseJieshuEnd" ? 1 : 2);
		},
	},

	// ── 永夜归反 -世间开明- ──────────────────────────────────────
	// 描述：出牌阶段限一次，重置所有「神宝」的效果计数。
	//
	// 「重置计数」直接交给引擎的 player.refreshSkill —— 它就是【中流】用的那套
	// （把 getStat("triggerSkill") / getStat("skill") 里对应技能的计数删掉，
	//   见 player.js 的 refreshSkill），比自己去删 storage 靠谱。
	kgy_shijian: {
		audio: false,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			const stat = player.getStat("triggerSkill") || {};
			return KGY_SHENBAO_SKILLS.some(name => (stat[name] || 0) > 0);
		},
		async content(event, trigger, player) {
			const reset = player.refreshSkill(KGY_SHENBAO_SKILLS);
			game.log(player, "重置了所有「神宝」的效果计数", reset.length ? `（${reset.length} 项）` : "");
		},
		ai: {
			order: 4,
			result: { player: 1 },
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 安洁莉娜 · 酸橙的心意（蜀 / 4体力）
	//
	// 只有一个技能【重力自定义】，效果全压在**目标身上那一个标记技能**里：
	//   · player 的 drawAfter / discardAfter —— 把目标的摸牌翻成弃牌、弃牌翻成摸牌；
	//   · global 的 phaseEnd / die —— 在「安洁莉娜的下个回合结束」按批摘掉自己。
	//
	// ★ 到期逻辑为什么写在**标记自己**身上，而不是安洁莉娜身上的一个 group 子技能：
	//   实机踩过 —— 挂在安洁莉娜身上、靠 group 展开的那个「定时器」从来没被触发过，
	//   标记于是一直挂在别人身上，过了多少回合都不消失。
	//   改成像【永远】的 kgy_yongyuan_mark 那样「标记技能自己监听时机」之后就正常了，
	//   那种写法是 addSkill 动态加上的独立技能，已经被实机验证能触发。
	//   附带好处：安洁莉娜阵亡后标记照样会清（原来她一死定时器就没了，标记永久残留）。
	//
	// ★★ 到期是**每层单独计时**的，不是整体续期：
	//   早先的写法在每次发动时把到期时间整体重置成「下个回合结束」，
	//   结果只要每回合都发动，标记就永远不消失（实机就是这样：3 轮各用两次，
	//   层数攒到 6，一次都没摘过）。描述里「直到你下个回合的结束阶段」是
	//   对**每一次发动**而言的，先挂的那批到点就该走。
	//   所以 storage 里存一个批次表：
	//     ajln_zhongli_batches = [{ n, left, fresh? }, …]
	//       n     = 这一批有几层
	//       left  = 还要经过几个「安洁莉娜的回合结束」
	//       fresh = 本回合刚挂上，本回合的结束阶段不算数
	//   每经过一次她的 phaseEnd，非 fresh 的批次 left -= 1，减到 0 就摘那 n 层；
	//   层数归零时把技能整个摘掉。**后来的发动不会给先前那批续期。**
	//
	// 为什么不能直接用 addTempSkill(…, { player: "phaseEnd" })：
	//   那句 expire 的意思是「**下一次**你的结束阶段到时移除」，而描述要的是
	//   「**下个回合**的结束阶段」—— 出牌阶段发动时，本回合的结束阶段马上就来了，
	//   差整整一个回合，所以才需要 fresh 这一层「本回合不算数」的判定。
	// ══════════════════════════════════════════════════════════════
	ajln_zhongli: {
		// 六条语音（作战中1~4 / 部署1 / 部署2），发动时随机一条
		audio: "ext:方舟/skill:6",
		enable: "phaseUse",
		// usable: N = 每回合限 N 次
		usable: 2,
		filterCard: true,
		position: "h",
		selectCard: 1,
		selectTarget: 1,
		// ★ 技能级的选目标**必须**配一个 filterTarget。
		//   只写 selectTarget 的话引擎不会生成选目标的界面，
		//   event.targets 会是空数组 —— 实机踩过：
		//   `const target = event.targets[0]` 直接是 undefined，后面 addSkill 就炸了。
		//   描述是「选择一名角色」，所以任意在场角色（含自己）都行。
		filterTarget(card, player, target) {
			return target.isIn();
		},
		filter(event, player) {
			return player.countCards("h") > 0 && game.hasPlayer(current => current.isIn());
		},
		async content(event, trigger, player) {
			const target = event.targets[0];
			if (!target) {
				return;
			}
			// ★ addSkill 是幂等的（已经挂着就不会重复加），**层数**靠标记累加 ——
			//   所以同一个角色可以被反复指定，摸一次牌就弃 N 张（N = 「重力」标记层数）。
			target.addSkill("ajln_zhongli_mark");
			target.addMark("ajln_zhongli_mark", 1, false);
			// ★ 每层**单独计时**，所以用「批次」把每次挂上的层数记下来：
			//   n    = 这一批有几层
			//   left = 还要经过几个「安洁莉娜的回合结束」才摘
			//   fresh= 本回合刚挂上，本回合的结束阶段不算数
			//          （出牌阶段发动完，结束阶段立刻就来了，不排除掉会当场到期）
			//   同一个出牌阶段里连按两次算**同一批** —— 它们本来就同时到期。
			//   这样「回合 N 挂的」和「回合 N+1 挂的」各按各的回合到期，
			//   后来的发动**不会**把先前那批一起续期。
			const batches = target.storage.ajln_zhongli_batches || (target.storage.ajln_zhongli_batches = []);
			const last = batches[batches.length - 1];
			if (last && last.fresh) {
				last.n += 1;
			} else {
				batches.push({ n: 1, left: 1, fresh: true });
			}
			// ★ 记下「是谁贴的」：到期判定要看**这个人的**回合，
			//   标记技能得靠它来过滤。存 playerid 而不是玩家对象 ——
			//   联机时 storage 要被序列化同步，对象引用活不下来。
			target.storage.ajln_zhongli_from = player.playerid;
			game.log(player, "对", target, "发动了", "【重力自定义】");
		},
		ai: {
			order: 5,
			result: {
				// 「摸牌→弃牌」是负面，「弃牌→摸牌」是正面，净下来偏负面，
				// 所以 AI 优先丢给敌人（get.attitude 对敌人是负的）
				target(player, target) {
					return -get.attitude(player, target);
				},
			},
		},
	},
	// 贴在目标身上的那半：摸牌翻弃牌、弃牌翻摸牌
	ajln_zhongli_mark: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "ajln_zhongli",
		mark: true,
		marktext: "重力",
		intro: {
			name: "重力自定义",
			content: "锁定技，你非因「重力自定义」摸牌时，弃置一张牌；你非因「重力自定义」弃牌时，摸一张牌。（此标记可叠加，有几层就弃/摸几张；每一层各自在自己被贴上的下个回合结束时到期）",
		},
		// player：自己的摸牌 / 弃牌 —— 效果本体
		// global：**贴标记那个人**（安洁莉娜）的回合结束 / 阵亡 —— 到期管理
		trigger: { player: ["drawAfter", "discardAfter"], global: ["phaseEnd", "die"] },
		filter(event, player, name) {
			// ★ 两类时机混在同一个技能里，用 filter 的第三个参数（引擎传的就是
			//   triggername）分辨。注意不能看 event.name —— drawAfter / phaseEnd
			//   这些都是引擎发出的**时机名**，事件本身叫 "draw" / "phaseLoop"。
			if (name == "phaseEnd" || name == "die") {
				// 只有「贴标记那个人」的回合结束（或他的阵亡）才算数
				const from = player.storage.ajln_zhongli_from;
				if (from == null || !event.player || event.player.playerid != from) {
					return false;
				}
				// ★ 这里**每个**回合结束都要发动 —— 每层各减一，减到 0 的才摘。
				//   不能像早先那样用「有没有到期的」当闸门，否则新挂的那批
				//   会把老批的到期一起按下去。
				return true;
			}
			// ★ 这个闸门是**必须**的：摸牌翻出来的弃牌、弃牌翻出来的摸牌
			//   都会再触发一次自己，不拦就是无限递归。
			//   闸门用 storage 而不是局部变量 —— content 里 await 期间新开的事件
			//   走的是同一条 filter，只有写在角色身上才拦得住。
			if (player.storage.ajln_zhongli_busy) {
				return false;
			}
			if (name == "drawAfter") {
				return event.num > 0;
			}
			return Array.isArray(event.cards) && event.cards.length > 0;
		},
		async content(event, trigger, player) {
			const name = event.triggername;
			// ── 到期管理（global）──
			if (name == "die") {
				// 贴标记的人阵亡了，标记跟着消失
				player.removeSkill("ajln_zhongli_mark");
				return;
			}
			if (name == "phaseEnd") {
				// ★「贴标记那个人」的回合结束：给**每一批**各减一个回合，
				//   减到 0 的那批摘掉 —— 本回合刚挂上的那批只脱掉 fresh 标记，
				//   回合数不动（它的到期时间在下一个回合结束）。
				const batches = player.storage.ajln_zhongli_batches || [];
				const keep = [];
				let removed = 0;
				for (const batch of batches) {
					if (batch.fresh) {
						delete batch.fresh;
						keep.push(batch);
						continue;
					}
					batch.left -= 1;
					if (batch.left <= 0) {
						removed += batch.n;
					} else {
						keep.push(batch);
					}
				}
				player.storage.ajln_zhongli_batches = keep;
				if (removed > 0) {
					// 万一批次记录和实际层数对不上（理论上不会），以实际层数为准
					player.removeMark("ajln_zhongli_mark", Math.min(removed, player.countMark("ajln_zhongli_mark")));
				}
				// 层数清空了就把技能摘掉 —— 留着的话摸牌弃牌还会继续触发效果
				if (player.countMark("ajln_zhongli_mark") <= 0) {
					player.removeSkill("ajln_zhongli_mark");
				}
				return;
			}
			// ── 摸牌 / 弃牌对调（player）──
			player.storage.ajln_zhongli_busy = true;
			try {
				// 「重力」标记有几层，就弃/摸几张
				const layers = Math.max(1, player.countMark("ajln_zhongli_mark"));
				if (name == "drawAfter") {
					// 摸了牌 —— 反过来弃 layers 张（手牌不够就有几张弃几张）
					if (player.countCards("he") > 0) {
						await player
							.chooseToDiscard({
								position: "he",
								selectCard: [1, layers],
								forced: true,
								prompt: `重力自定义：弃置${get.cnNumber(layers)}张牌`,
							})
							.forResult();
					}
				} else {
					// 弃了牌 —— 反过来摸 layers 张
					await player.draw(layers);
				}
			} finally {
				delete player.storage.ajln_zhongli_busy;
			}
		},
		onremove(player, skill) {
			delete player.storage[skill];
			delete player.storage.ajln_zhongli_batches;
			delete player.storage.ajln_zhongli_busy;
			delete player.storage.ajln_zhongli_from;
		},
	},
	// ══════════════════════════════════════════════════════════════
	// 华法琳 · 实验狂魔（蜀 / 六上限 两血 一甲）
	//
	// 体力配置写在 character.js 的武将表里：hp = 开局体力，maxHp = 体力上限，
	// hujia = 护甲 —— 三个是**分开**的字段，所以「六上限两血一甲」就是
	// { hp: 2, maxHp: 6, hujia: 1 }。
	//
	// 【血浆】是「先补后掉」：两边各回一点、再各掉一点体力，
	// 本质上是用自己的两点体力换目标的「血量上限空间」，
	// 换来的是目标下个回合的每一次伤害都白送 1 点。
	// 【实验】按弃掉的两张牌颜色分岔：同色给「回血变多」，异色给「上限=体力」。
	// ══════════════════════════════════════════════════════════════
	hfl_xuejiang: {
		// 六条语音（作战中1~4 / 部署1 / 部署2），发动时随机一条
		audio: "ext:方舟/skill:6",
		enable: "phaseUse",
		usable: 2,
		selectTarget: 1,
		filter(event, player) {
			return game.hasPlayer(current => current != player);
		},
		filterTarget: lib.filter.notMe,
		async content(event, trigger, player) {
			const target = event.targets[0];
			// 按描述的顺序：你与其回复1点，然后你与其失去1点
			await player.recover(1);
			await target.recover(1, player);
			await player.loseHp(1);
			await target.loseHp(1);
			// 「其下个回合」= 目标自己的下个回合。
			// 发动时一定在华法琳的出牌阶段，也就是**华法琳的回合**，
			// 所以目标此刻必然不在自己的回合里，{ player: "phaseAfter" }
			// 命中的就是它下一个回合结束。
			target.addTempSkill("hfl_xuejiang_buff", { player: "phaseAfter" });
		},
		ai: {
			order: 5,
			result: {
				// 目标下一次出手的伤害都会 +1，所以只对队友用
				target(player, target) {
					return get.attitude(player, target);
				},
			},
		},
	},
	// 血浆的下个回合效果：其造成伤害时，先失去1点体力，再让伤害+1
	hfl_xuejiang_buff: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "hfl_xuejiang",
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			// 「其下个回合」：只认目标自己回合里造成的伤害
			return _status.currentPhase == player;
		},
		async content(event, trigger, player) {
			await player.loseHp(1);
			trigger.num += 1;
		},
	},

	hfl_shiyan: {
		audio: "ext:方舟/skill:6",
		enable: "phaseUse",
		filterCard: true,
		position: "he",
		selectCard: 2,
		selectTarget: 1,
		// ★ 同 ajln_zhongli：技能级的选目标必须配 filterTarget，
		//   否则引擎不生成选目标界面，event.targets 会是空的。
		//   描述是「选择一名角色」，任意在场角色（含自己）都行。
		filterTarget(card, player, target) {
			return target.isIn();
		},
		filter(event, player) {
			return player.countCards("he") >= 2;
		},
		async content(event, trigger, player) {
			const target = event.targets[0];
			if (!target) {
				return;
			}
			const colors = event.cards.map(card => get.color(card, player));
			// 两张都是无色（虚拟牌）时按「不同色」处理
			const same = colors[0] != "none" && colors[0] == colors[1];
			// 「本回合」指的是**华法琳**的回合 —— 发动时就在她的出牌阶段，
			// 所以挂 { global: "phaseAfter" } 会在当前这个回合结束时一起摘掉，
			// 而不是等目标自己的回合。
			if (same) {
				target.addTempSkill("hfl_shiyan_buff", { global: "phaseAfter" });
			} else {
				// 「视为」得**立刻**生效，不能等下一次体力变化：
				// 先记下原上限（hfl_shiyan_buff2 移除时还回去），再压平。
				target.storage.hfl_shiyan_origin = target.maxHp;
				target.maxHp = Math.max(1, target.hp);
				target.update();
				target.addTempSkill("hfl_shiyan_buff2", { global: "phaseAfter" });
			}
			game.log(player, "令", target, same ? "的体力恢复量+1" : "的体力上限视为其体力值");
		},
		ai: {
			order: 4,
			result: {
				target(player, target) {
					return get.attitude(player, target);
				},
			},
		},
	},
	// 实验·同色：本回合体力恢复量+1
	hfl_shiyan_buff: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "hfl_shiyan",
		mark: true,
		marktext: "实验",
		intro: { name: "实验", content: "本回合你的体力恢复量+1。" },
		trigger: { player: "recoverBegin" },
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},
	// 实验·异色：本回合生命上限视为其体力值（至少为1）
	hfl_shiyan_buff2: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "hfl_shiyan",
		mark: true,
		marktext: "归零",
		intro: { name: "实验", content: "本回合你的体力上限视为你的体力值（至少为1）。" },
		// 引擎没有「体力上限」的 mod 钩子（player.maxHp 是个普通字段，全引擎都在直接读它），
		// 所以这里只能真去改这个字段，并在技能移除时把原值还回去。
		trigger: { player: "changeHp" },
		async content(event, trigger, player) {
			player.maxHp = Math.max(1, player.hp);
			player.update();
		},
		onremove(player, skill) {
			const origin = player.storage.hfl_shiyan_origin;
			if (typeof origin == "number") {
				player.maxHp = Math.max(1, origin);
			}
			delete player.storage.hfl_shiyan_origin;
			player.update();
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 乌啾 · 羽隐愈疗（魏 / 3体力）
	//
	// 【捉迷藏】是主动的那一半：掉自己1点体力、丢一张红色手牌，
	// 换一个近处伤员（距离不大于1）的1点体力。
	// 【迷彩】才是整套牌的核心 —— 每当**乌啾使人回复体力**就给对方贴一层迷彩，
	// 然后判定一次；四种花色各对应一段额外效果，♣ 还能「弃红牌再来一遍」，
	// 所以一次回复可能滚出一长串收益。
	// 【保身】是被动：成为锦囊目标时赌一次判定，红色就把这张牌整个取消掉并收进手里。
	//
	// ★「迷彩-基本 / 迷彩-锦囊」这两个 mod 必须挂在**被标记的人**身上，
	//   不能挂在乌啾身上：引擎的 targetEnabled 判定是
	//       game.checkMod(card, player, target, "unchanged", "targetEnabled", target)
	//   —— 技能拥有者是**目标**（见 library/index.js 的 lib.filter.targetEnabled）。
	//   所以这两个技能走 addSkill 给目标，而不是 addGlobalSkill。
	//
	// 说明：作者的原始描述里，第二段（从「每回合限两次」开始）没有写技能名，
	// 这里按它赋予的标记取名【迷彩】。
	// ══════════════════════════════════════════════════════════════
	wj_zhuomicang: {
		// 五条语音（作战中1~4 / 选中干员1），发动时随机一条
		audio: "ext:方舟/skill:5",
		enable: "phaseUse",
		usable: 1,
		filterCard(card) {
			return get.color(card) == "red";
		},
		position: "h",
		selectCard: 1,
		selectTarget: 1,
		filter(event, player) {
			// 先掉自己1点体力，所以残血时不给点
			if (player.hp <= 1 || !player.countCards("h", { color: "red" })) {
				return false;
			}
			return game.hasPlayer(current => current.isAlive() && wjZhuomicangTargetable(player, current));
		},
		filterTarget(card, player, target) {
			return wjZhuomicangTargetable(player, target);
		},
		async content(event, trigger, player) {
			const target = event.targets[0];
			await player.loseHp(1);
			// 显式带上 source：乌啾的【迷彩】就是靠 recover 事件的 source 认出「你使」
			await target.recover(1, player);
		},
		ai: {
			order: 5,
			result: {
				target(player, target) {
					return get.attitude(player, target) * 2;
				},
			},
		},
	},

	// ── 迷彩 ─────────────────────────────────────────────────────
	// 描述：**锁定技**，每回合限两次，你使任何角色恢复体力后，你选择并令其获得
	//       「迷彩-基本」或「迷彩-锦囊」，然后你进行一次判定：
	//       ♥：你可以令与其距离不大于2的一名其他未被此效果影响的角色恢复1点体力；
	//       ♦：你令一名角色抽3张牌；
	//       ♣：你可以弃置一张红色牌并重复此流程；
	//       ♠：你恢复1点体力值并抽1张牌。
	//       **判定后无论结果如何**，你的下个回合开始时，
	//       你移去所有由你产生的「迷彩」系标记并抽等量的牌。
	//
	// ★ 最后那句「移去标记」**不属于 ♠**：作者的原稿把它写在 ♠ 那一行里
	//   （「若如此做…」），但设计意图是**判定之后无论花色都执行**的收尾。
	//   所以 `player.addSkill("wj_micai_clear")` 放在花色分岔**之外**。
	//
	// ★ 是**锁定技**：满足「你使角色回复体力」就自动发动，不弹「是否发动」。
	//   效果内部的选择（♥/♦ 选谁、♣ 弃不弃牌、迷彩二选一）照旧要选 ——
	//   `forced` 管的是「发不发动」，不是「发动的过程中要不要做选择」。
	wj_micai: {
		audio: "ext:方舟/skill:5",
		locked: true,
		forced: true,
		trigger: { global: "recoverEnd" },
		usable: 2,
		filter(event, player) {
			// 「你使」：只认 recover 事件的 source。
			// 引擎在 recover() 里会把 source 兜底成当前事件的 player，
			// 所以乌啾用【桃】救人、或她自己技能里的 recover 都算；别人救她不算。
			return event.source == player && !!event.player && event.player.isAlive();
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			// ♥ 要求「未被此效果影响」—— 记的是本次流程里已经因此回过血的人，
			// 所以每次发动都重置，流程结束再清掉。
			player.storage.wj_micai_affected = [];
			const heartOk = current =>
				current != target &&
				current.isAlive() &&
				get.distance(target, current) <= 2 &&
				!player.storage.wj_micai_affected.includes(current);
			// ♣ 会「重复此流程」，所以整段包在一个可重入的循环里
			let again = true;
			while (again) {
				again = false;
				// ① 你选择并令其获得一种迷彩
				const choice = await player
					.chooseControl("basic", "trick")
					.set("prompt", `迷彩：令${get.translation(target)}获得一种迷彩`)
					.set("choiceList", ["迷彩-基本（不能成为【杀】的目标）", "迷彩-锦囊（不能成为非延时锦囊牌的目标）"])
					.set("ai", () => (target.hp > 1 ? 0 : 1))
					.forResult();
				const skill = choice.control == "basic" ? "wj_micai_basic" : "wj_micai_trick";
				target.addSkill(skill);
				target.addMark(skill, 1);
				// ② 你进行一次判定（这里不看成败，只要那张牌的花色）
				const judge = await player.judge(() => 1).forResult();
				const suit = get.suit(judge.card, player);
				// ③ 按花色分岔
				if (suit == "heart") {
					if (game.hasPlayer(heartOk)) {
						const result = await player
							.chooseTarget("迷彩：令一名其他角色回复1点体力", (card, player, current) => heartOk(current))
							.set("ai", current => get.attitude(player, current))
							.forResult();
						if (result.bool && result.targets.length) {
							const healed = result.targets[0];
							player.storage.wj_micai_affected.push(healed);
							await healed.recover(1, player);
						}
					}
				} else if (suit == "diamond") {
					const result = await player
						.chooseTarget("迷彩：令一名角色抽三张牌", (card, player, current) => current.isAlive())
						.set("ai", current => get.attitude(player, current))
						.forResult();
					if (result.bool && result.targets.length) {
						await result.targets[0].draw(3);
					}
				} else if (suit == "club") {
					if (player.countCards("he", { color: "red" })) {
						const result = await player
							.chooseToDiscard({
								position: "he",
								filterCard: card => get.color(card, player) == "red",
								prompt: "迷彩：弃置一张红色牌以重复此流程",
							})
							.forResult();
						if (result.bool) {
							again = true;
						}
					}
				} else {
					// ♠
					await player.recover(1, player);
					await player.draw(1);
				}
				// ★「你移去所有由你产生的『迷彩』系标记并抽等量的牌」**不是 ♠ 的专属结果**，
				//   而是**判定之后无论花色都执行**的收尾：挂一个只在自己回合开始做事的技能，
				//   它触发一次就把自己摘掉（见 wj_micai_clear）。
				//   挂在循环里也没关系 —— addSkill 是幂等的，一轮里重复判定只会重复挂同一个技能。
				player.addSkill("wj_micai_clear");
			}
			delete player.storage.wj_micai_affected;
		},
	},

	// 「迷彩-基本」：有它的人不能成为【杀】的目标
	wj_micai_basic: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "wj_micai",
		mark: true,
		marktext: "迷彩-基本",
		intro: {
			name: "迷彩-基本",
			content: "锁定技，你不能成为【杀】的目标。",
		},
		mod: {
			targetEnabled(card, player, target) {
				if (card.name == "sha") {
					return false;
				}
			},
		},
		onremove(player, skill) {
			// 【捉迷藏】的第三条：移去判定区的牌 —— 但主语是**乌啾自己**，
			// 「你失去『迷彩』系标记时，移去**你**判定区的所有牌」。
			// 迷彩绝大多数时候是贴给别人的，所以这里必须认一下
			// 「失去标记的人是不是乌啾本人」：`hasSkill("wj_micai")` 就是那个判据
			// （她是【迷彩】的拥有者）。别人掉迷彩不该被清判定区。
			//
			// 技能被 removeSkill 摘掉时标记会一起没，所以「失去标记」挂在 onremove 上。
			// onremove 不能 await，但 loseToDiscardpile 只是把事件排进队列，够用了。
			if (player.hasSkill("wj_micai")) {
				const cards = player.getCards("j");
				if (cards.length) {
					player.loseToDiscardpile(cards);
				}
			}
			delete player.storage[skill];
		},
	},
	// 「迷彩-锦囊」：有它的人不能成为非延时锦囊牌的目标
	wj_micai_trick: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "wj_micai",
		mark: true,
		marktext: "迷彩-锦囊",
		intro: {
			name: "迷彩-锦囊",
			content: "锁定技，你不能成为非延时锦囊牌的目标。",
		},
		mod: {
			targetEnabled(card, player, target) {
				// get.type 对普通锦囊返回 "trick"、延时锦囊返回 "delay"
				if (get.type(card) == "trick") {
					return false;
				}
			},
		},
		onremove(player, skill) {
			// 同 wj_micai_basic：只有**乌啾自己**失去迷彩时才清判定区
			if (player.hasSkill("wj_micai")) {
				const cards = player.getCards("j");
				if (cards.length) {
					player.loseToDiscardpile(cards);
				}
			}
			delete player.storage[skill];
		},
	},
	// ♠ 的收尾：自己下个回合**开始**时清空全场迷彩，按清掉的总数摸牌。
	// ★ 时机用 `phaseBegin`（回合开始）而不是 `phaseZhunbeiBegin`（准备阶段开始）——
	//   描述写的是「你的下个**回合**开始时」。
	// ★ 它不是 ♠ 的专属结果：每次判定之后都会挂上（见 wj_micai 的 content）。
	wj_micai_clear: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "wj_micai",
		trigger: { player: "phaseBegin" },
		async content(event, trigger, player) {
			player.removeSkill("wj_micai_clear");
			let num = 0;
			for (const current of game.players.concat(game.dead)) {
				for (const skill of ["wj_micai_basic", "wj_micai_trick"]) {
					if (current.hasSkill(skill)) {
						num += current.countMark(skill);
						current.removeSkill(skill);
					}
				}
			}
			if (num > 0) {
				game.log(player, "移去了所有「迷彩」标记");
				await player.draw(num);
			}
		},
	},

	// ── 保身 ─────────────────────────────────────────────────────
	// 描述：每回合限一次，当你成为锦囊牌的目标时，你可以进行一次判定，
	//       若结果为红色，你取消此牌并获得之。
	wj_baoshen: {
		audio: "ext:方舟/skill:5",
		trigger: { target: "useCardToTarget" },
		usable: 1,
		filter(event, player) {
			return event.player != player && get.type2(event.card) == "trick";
		},
		check(event, player) {
			return get.effect(player, event.card, event.player, player) < 0;
		},
		async content(event, trigger, player) {
			const judge = await player.judge(card => (get.color(card, player) == "red" ? 1 : -1)).forResult();
			if (!judge.bool) {
				return;
			}
			// 「取消此牌」：把自己从这次的目标里摘出去。
			// 这三步是引擎里取消目标的固定写法（同【绝勇】【持节】）。
			trigger.targets.remove(player);
			const parent = trigger.getParent();
			if (parent && parent.triggeredTargets2) {
				parent.triggeredTargets2.remove(player);
			}
			trigger.untrigger();
			// 「获得之」：实体牌直接从处理区收进手里（虚拟牌没有实体可拿）
			if (Array.isArray(trigger.cards) && trigger.cards.length) {
				await player.gain(trigger.cards, "gain2");
			}
			game.log(player, "取消了", trigger.card, "并获得之");
		},
		ai: {
			threaten: 1.2,
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 煌 · 好兄弟（蜀 / 4体力） / 好运煌（蜀 / 4体力）
	//
	// 九个技能全部由上面 huangSkillSet 按前缀生成两份：
	//   huang  —— 煌本人，【链锯】是纯赌局；
	//   hlucky —— 好运煌，【链锯】抽牌前先把牌堆顶铺成两张视为红色的牌。
	// 两套的技能名与 storage 键都带前缀，同场也不会互相串账。
	// ══════════════════════════════════════════════════════════════
	...huangSkillSet("huang"),
	...huangSkillSet("hlucky", { lucky: true }),

	// ══════════════════════════════════════════════════════════════
	// 涤火杰西卡 · 流泪猫猫头（群 / 3体力 / 主公）
	//
	// 动手前先把两条「引擎其实早就有」的约定记在这儿，免得下次又自己造：
	//
	// ★「持恒技」= `persevereSkill: true`。它由 get.skillCategoriesOf 翻成
	//   「持恒技」显示出来（noname/get/index.js），唯一的硬效果是让〖封印〗
	//   〖白板〗那类「非锁定技失效」够不着这些技能 —— 见
	//   noname/library/skill.js 里 fengyin / baiban 的 skillBlocker。
	//
	// ★「使命技」= `dutySkill: true`，官方参考是神太史慈的〖破围〗tspowei
	//   （character/shiji/skill.js）。要点三条：
	//     ① 主技能的 group 里挂上 achieve / fail 两个子技能；
	//     ② 无论成功还是失败，都要调 `player.awakenSkill(主技能名)`；
	//     ③ awakenSkill 内部走的是 disableSkill(技能名 + "_awake", 技能名)，
	//        而 disableSkill 会**顺着 group 递归禁用**（见
	//        noname/library/element/player.js 第 11197 行那段），
	//        所以使命一判定完，整个技能连同全部子技能自动失效，
	//        不需要自己 removeSkill。
	//
	// 另外这三个技能都没有配音素材，统一写 audio: false，
	// 免得引擎去 audio/skill/ 下找不存在的 mp3。
	// ══════════════════════════════════════════════════════════════

	// ── 盾牌（持恒技）────────────────────────────────────────────
	//
	// 三段效果拆成四个子技能：
	//   hujia / hujia_damage —— 「护甲每次只能失去一点」
	//   gain                 —— 用桃、防具牌进出时加甲
	//   lose                 —— 因伤害掉甲后的三选一
	dhjxk_dunpai: {
		audio: false,
		persevereSkill: true,
		group: ["dhjxk_dunpai_hujia", "dhjxk_dunpai_hujia_damage", "dhjxk_dunpai_gain", "dhjxk_dunpai_lose"],
	},

	// 「每次只能失去一点」的非伤害那一路。
	//
	// ★ 用 changeHujiaBegin 而不是 changeHujiaAfter：引擎给每个事件都跑了
	//   Before / Begin 两个时机（见 library/element/gameEvent.js 的 loop），
	//   Begin 卡在 content 之前，正好赶得上在 `player.hujia += num` 落账前
	//   把 num 削成 -1。
	dhjxk_dunpai_hujia: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_dunpai",
		trigger: { player: "changeHujiaBegin" },
		filter(event, player) {
			return event.num < -1;
		},
		async content(event, trigger, player) {
			trigger.num = -1;
		},
	},

	// 伤害那一路。
	//
	// ★ 为什么上面那条拦不住伤害：伤害消耗几点护甲根本不在 changeHujia 里定价，
	//   而是 changeHp 一上来就 `event.hujia = Math.min(-num, player.hujia)`，
	//   按「有多少甲就挡多少」一次算完，再回头喊一声 changeHujia(-全额)
	//   （library/element/content.js 的 changeHp，第 11602 行）。
	//   所以这里抢在 damageBegin4 动手 —— 此时最终伤害值已经定了、changeHp
	//   还没跑：先立 event.nohujia 挡掉引擎那套全额抵挡，自己扣 1 点甲，
	//   剩下的伤害照常落到体力上。
	dhjxk_dunpai_hujia_damage: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_dunpai",
		trigger: { player: "damageBegin4" },
		filter(event, player) {
			return !event.nohujia && !player.hasSkillTag("nohujia") && event.num > 1 && player.hujia > 0;
		},
		async content(event, trigger, player) {
			trigger.nohujia = true;
			trigger.num -= 1;
			// 把伤害来源捎给 dhjxk_dunpai_lose：这个 changeHujia 事件是我们
			// 在 damageBegin4 里造的，它的事件链未必还挂着 damage，
			// 与其赌 getParent，不如直接递过去
			player.storage.dhjxk_dunpai_source = trigger.source || null;
			player.changeHujia(-1);
		},
	},

	// 「使用【桃】或防具牌置入/失去装备区时，你获得1点护甲」。
	// 三类时机一起挂，filter 里按 event.name 分流。
	//
	// ★ 这一段是**自动结算**的（作者要求，不弹「是否发动」），所以用
	//   `forced: true` + content 直接干活，既不要 cost 也不要 direct。
	//
	//   顺带把这三个骨架的区别记在这儿，免得以后再挑错：
	//     · forced: true  —— 不询问、直接跑 content，引擎还会自动补 logSkill
	//                        （createTrigger 里 `if (event.revealed || info.forced) result = {bool:true}`）
	//     · cost + content —— 「可选触发技」的正规骨架：cost 里问，bool 为真才跑 content
	//     · direct: true   —— 绕过询问流程的旁路，会顺手 swapPlayerAuto，尽量别用
	dhjxk_dunpai_gain: {
		audio: false,
		charlotte: true,
		forced: true,
		sourceSkill: "dhjxk_dunpai",
		trigger: { player: ["useCardAfter", "equipEnd", "loseEnd"] },
		filter(event, player) {
			if (event.name == "useCard") {
				return !!event.card && event.card.name == "tao";
			}
			// 「置入装备区」这一路：equip 的 content 会把 event.card 换成 VCard，
			// 所以两处都查一遍，event.cards 兜底
			if (event.name == "equip") {
				const list = [event.card, ...(event.cards || [])].filter(Boolean);
				return list.some(card => get.subtype(card, false) == "equip2");
			}
			// 「从装备区失去」这一路：loseEnd 的 event.es 就是这批失去的装备牌
			return (event.es || []).some(card => get.subtype(card, false) == "equip2");
		},
		async content(event, trigger, player) {
			await player.changeHujia(1);
		},
	},

	// 「失去护甲时三选一」——三个选项都要拿伤害来源说事，
	// 所以没有伤害来源的掉甲（技能、牌）干脆不触发，符合作者「不是伤害引起的
	// 就没有这个选项」的说明。
	dhjxk_dunpai_lose: {
		audio: false,
		charlotte: true,
		sourceSkill: "dhjxk_dunpai",
		trigger: { player: "changeHujiaAfter" },
		filter(event, player) {
			if (event.num >= 0) {
				return false;
			}
			// 来源有两条路：① 上面的 hujia_damage 直接递过来的；
			//               ② 引擎自己扣的甲（伤害只有 1 点那种），从事件链上找
			let source = player.storage.dhjxk_dunpai_source || null;
			delete player.storage.dhjxk_dunpai_source;
			if (!source) {
				const damage = event.getParent("damage");
				if (damage && damage.source) {
					source = damage.source;
				}
			}
			if (!source || !source.isIn()) {
				return false;
			}
			// filter 里存一下，content 直接取，省得再猜一遍
			player.storage.dhjxk_dunpai_src = source;
			return true;
		},
		// 同样走 cost + content（理由见 dhjxk_dunpai_gain 上面的注释）。
		// 选择结果用 player.storage 递给 content —— cost 的 result 除了官方的
		// cost_data 之外不会传下去，而 cancel 时引擎会自己把 content 跳掉。
		async cost(event, trigger, player) {
			const source = player.storage.dhjxk_dunpai_src;
			if (!source) {
				event.result = { bool: false };
				return;
			}
			const srcHand = source.countCards("h");
			const cap = Math.max(source.hp, srcHand);
			// ①「弃置等同于伤害来源手牌数的手牌」——主语是**你**：
			//    弃的是你自己的手牌，张数取伤害来源的手牌数。
			//    自己手牌不够时这一项直接置灰（写法同 shiji 的 tspowei_use：
			//    可用项单独攒一个 list，不可用的在 choiceList 里加淡化 span）。
			const canDiscard = srcHand > 0 && player.countCards("h") >= srcHand;
			const choiceList = [
				`弃置你的${get.cnNumber(srcHand)}张手牌，然后令${get.translation(source)}失去1点体力`,
				`获得${get.translation(source)}区域内的一张牌`,
				`将你的手牌摸至${get.cnNumber(cap)}张`,
			];
			const list = [];
			if (canDiscard) {
				list.push("选项一");
			} else {
				choiceList[0] = `<span style="opacity:0.5">${choiceList[0]}</span>`;
			}
			list.push("选项二", "选项三");
			event.result = await player
				.chooseControl(list, "cancel2")
				.set("prompt", get.prompt("dhjxk_dunpai", source))
				.set("choiceList", choiceList)
				.set("ai", () => {
					const evt = _status.event;
					const src = evt.player.storage.dhjxk_dunpai_src;
					const me = evt.player;
					if (!src) {
						return "cancel2";
					}
					const hand = src.countCards("h");
					if (hand > 0 && me.countCards("h") >= hand && get.damageEffect(src, me, me) > 0) {
						return "选项一";
					}
					if (me.countCards("h") + 2 <= Math.max(src.hp, hand)) {
						return "选项三";
					}
					if (src.countCards("hej") > 0) {
						return "选项二";
					}
					return "cancel2";
				})
				.forResult();
			player.storage.dhjxk_dunpai_pick = event.result.control;
		},
		async content(event, trigger, player) {
			const source = player.storage.dhjxk_dunpai_src;
			const pick = player.storage.dhjxk_dunpai_pick;
			delete player.storage.dhjxk_dunpai_src;
			delete player.storage.dhjxk_dunpai_pick;
			if (!source || !pick) {
				return;
			}
			const cap = Math.max(source.hp, source.countCards("h"));
			if (pick == "选项一") {
				await player.chooseToDiscard(source.countCards("h"), true, "h");
				await source.loseHp(1);
			} else if (pick == "选项二") {
				await player.gainPlayerCard(source, "hej", true);
			} else if (pick == "选项三") {
				const num = cap - player.countCards("h");
				if (num > 0) {
					await player.draw(num);
				}
			}
		},
	},

	// ── 手铳（持恒技）────────────────────────────────────────────
	dhjxk_shouchong: {
		audio: false,
		persevereSkill: true,
		group: ["dhjxk_shouchong_response", "dhjxk_shouchong_gain", "dhjxk_shouchong_lose"],
	},

	// ①「出牌阶段，基本牌被响应」——基本牌里只有【杀】会被响应，所以直接挂
	//    引擎的 shaMiss 时机（同 mobile 的〖利勇〗）。shaMiss 的 event.target
	//    就是那个打出【闪】的响应者。
	dhjxk_shouchong_response: {
		audio: false,
		charlotte: true,
		sourceSkill: "dhjxk_shouchong",
		trigger: { player: "shaMiss" },
		filter(event, player) {
			return player.isPhaseUsing() && !!event.target && event.target.isIn() && event.target.countCards("hej") > 0;
		},
		async cost(event, trigger, player) {
			const target = trigger.target;
			event.result = await player
				.chooseBool(get.prompt("dhjxk_shouchong", target), `是否弃置${get.translation(target)}区域内的一张牌？`)
				.set("ai", () => get.attitude(player, target) <= 0)
				.forResult();
		},
		async content(event, trigger, player) {
			await player.discardPlayerCard(trigger.target, "hej", true);
		},
	},

	// ②「武器牌置入你的手牌区」——gainAfter 只能说明「得到了」，
	//    还要用 get.position 确认它此刻真的在手牌区，才算「置入手牌区」。
	dhjxk_shouchong_gain: {
		audio: false,
		charlotte: true,
		sourceSkill: "dhjxk_shouchong",
		trigger: { player: "gainAfter" },
		filter(event, player) {
			return (event.cards || []).some(card => get.subtype(card, false) == "equip1" && get.position(card) == "h");
		},
		async cost(event, trigger, player) {
			// result.targets 会被引擎搬到 content 事件的 event.targets 上
			event.result = await player
				.chooseTarget(get.prompt("dhjxk_shouchong"), lib.filter.notMe)
				.set("prompt2", "视为对一名角色使用一张不计入次数限制的【杀】")
				.set("ai", target => get.effect(target, { name: "sha" }, player, player))
				.forResult();
		},
		async content(event, trigger, player) {
			await player.useCard(get.autoViewAs({ name: "sha" }, []), event.targets).set("addCount", false);
		},
	},

	// ③「武器牌从你的装备区失去」——loseEnd 的 event.es 就是这一批失去的装备牌
	dhjxk_shouchong_lose: {
		audio: false,
		charlotte: true,
		forced: true,
		sourceSkill: "dhjxk_shouchong",
		trigger: { player: "loseEnd" },
		filter(event, player) {
			return (event.es || []).some(card => get.subtype(card, false) == "equip1");
		},
		async content(event, trigger, player) {
			await player.draw(2);
		},
	},

	// ── 步銃 ─────────────────────────────────────────────────────
	dhjxk_buchong: {
		audio: false,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			const suitOk = card => {
				const suit = get.suit(card, player);
				return suit == "spade" || suit == "club";
			};
			return player.hasCard(suitOk, "he");
		},
		filterCard(card, player) {
			const suit = get.suit(card, player);
			return suit == "spade" || suit == "club";
		},
		position: "he",
		selectCard: 1,
		filterTarget(card, player, target) {
			return target != player && target.isIn();
		},
		async content(event, trigger, player) {
			const target = event.target;
			if (event.cards && event.cards.length) {
				await player.discard(event.cards);
			}
			const card = get.autoViewAs({ name: "sha", nature: "thunder" }, []);
			const next = player.useCard(card, target);
			next.set("addCount", false);
			// 把这次用牌挂出去，交给下面的一次性监听认领
			player.storage.dhjxk_buchong_use = next;
			player.addTempSkill("dhjxk_buchong_listen", { player: "phaseUseEnd" });
		},
		ai: {
			order: 8,
			result: {
				target: (player, target) => get.effect(target, { name: "sha", nature: "thunder" }, player, player),
			},
		},
	},

	// 上面那次【雷杀】如果被【闪】响应掉，可以摸一张并把〖步銃〗重置回来。
	//
	// ★ 「重置」不是 removeSkill，而是把 getStat("skill") 里记的那次发动抹掉 ——
	//   usable: 1 的闸门读的就是这个数，见 library/element/player.js 里
	//   引擎自己的重置逻辑（第 11102 行）也是这么干的。
	dhjxk_buchong_listen: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_buchong",
		trigger: { player: "shaMiss" },
		filter(event, player) {
			const use = player.storage.dhjxk_buchong_use;
			return !!use && event.getParent("useCard") == use;
		},
		async content(event, trigger, player) {
			delete player.storage.dhjxk_buchong_use;
			player.removeSkill("dhjxk_buchong_listen");
			const result = await player
				.chooseBool(get.prompt("dhjxk_buchong"), "是否摸一张牌并重置【步銃】？")
				.set("ai", () => true)
				.forResult();
			if (!result.bool) {
				return;
			}
			player.logSkill("dhjxk_buchong");
			await player.draw(1);
			if (player.getStat("skill").dhjxk_buchong) {
				delete player.getStat("skill").dhjxk_buchong;
			}
			game.log(player, "重置了技能", "#g【步銃】");
		},
	},

	// ── 舰炮 ─────────────────────────────────────────────────────
	dhjxk_jianpao: {
		audio: false,
		enable: "phaseUse",
		usable: 1,
		group: ["dhjxk_jianpao_jiu"],
		filter(event, player) {
			const need = dhjxkJianpaoNeed(player);
			// X ≥ 4：不再弃牌，无脑能发动
			if (need <= 0) {
				return true;
			}
			// ★ 光有牌不够，还得凑得出 need 种花色 —— 这是「可供弃置的牌不足」的真正含义
			return dhjxkJianpaoSuits(player) >= need;
		},
		// 弃 4-X 张**花色互不相同**的牌：靠 ui.selected.cards 逐个排除同花色。
		// 张数是**恰好** need（描述写的是「弃置4-X张」，不是「至多」），
		// 所以这里返回 [need, need] 而不是 [1, need] —— 跟 filter 的判据保持一致。
		selectCard() {
			const need = dhjxkJianpaoNeed(_status.event.player);
			return need <= 0 ? 0 : [need, need];
		},
		filterCard(card, player) {
			const suit = get.suit(card, player);
			return !ui.selected.cards.some(current => get.suit(current, player) == suit);
		},
		position: "he",
		filterTarget(card, player, target) {
			return target != player && target.isIn();
		},
		async content(event, trigger, player) {
			const used = dhjxkJianpaoUsed(player);
			if (event.cards && event.cards.length) {
				await player.discard(event.cards);
			}
			// 摸 X/2 张（向下取整）
			const draw = Math.floor(used / 2);
			if (draw > 0) {
				await player.draw(draw);
			}
			player.storage.dhjxk_jianpao_count = used + 1;
			// 视为使用一张【酒】【火杀】：「酒」的那一点加伤由
			// dhjxk_jianpao_jiu 兑现，靠牌上的 storage 标记认领，
			// 免得顺手把别的【杀】也加伤了
			const card = get.autoViewAs({ name: "sha", nature: "fire" }, []);
			card.storage = { dhjxk_jianpao_jiu: true };
			const next = player.useCard(card, event.target);
			next.set("addCount", false);
			player.storage.dhjxk_jianpao_use = next;
			player.addTempSkill("dhjxk_jianpao_listen", { player: "phaseUseEnd" });
		},
		ai: {
			order: 7,
			result: {
				target: (player, target) => get.effect(target, { name: "sha", nature: "fire" }, player, player),
			},
		},
	},

	// 【酒】的那一点加伤
	dhjxk_jianpao_jiu: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_jianpao",
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			return !!(event.card && event.card.storage && event.card.storage.dhjxk_jianpao_jiu);
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},

	// 「若该角色因此受到伤害」——盯着那一发火杀结算出来的伤害，
	// 然后弃 1~2 张【杀】、对受伤角色周围 1~2 名角色再各来一发【火杀】。
	dhjxk_jianpao_listen: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_jianpao",
		trigger: { player: "damageEnd" },
		filter(event, player) {
			const use = player.storage.dhjxk_jianpao_use;
			return !!use && event.source == player && event.getParent("useCard") == use;
		},
		async content(event, trigger, player) {
			const target = trigger.player;
			delete player.storage.dhjxk_jianpao_use;
			player.removeSkill("dhjxk_jianpao_listen");
			const count = Math.min(2, player.countCards("he", card => card.name == "sha"));
			if (count <= 0) {
				return;
			}
			const discard = await player
				.chooseToDiscard(get.prompt("dhjxk_jianpao", target), [1, count], "he", card => card.name == "sha")
				.forResult();
			if (!discard.bool) {
				return;
			}
			const num = discard.cards.length;
			const result = await player
				.chooseTarget(get.prompt("dhjxk_jianpao"), [1, num], (card, player2, target2) => {
					return target2 != player2 && target2.isIn() && get.distance(target, target2) <= 1;
				})
				.set("prompt2", `对${get.translation(target)}周围至多${get.cnNumber(num)}名角色各使用一张【火杀】`)
				.set("ai", target2 => get.effect(target2, { name: "sha", nature: "fire" }, player, player))
				.forResult();
			if (!result.bool) {
				return;
			}
			player.logSkill("dhjxk_jianpao", result.targets);
			for (const current of result.targets) {
				if (!current.isIn()) {
					continue;
				}
				await player.useCard(get.autoViewAs({ name: "sha", nature: "fire" }, []), current).set("addCount", false);
			}
		},
	},

	// ── 整备（持恒技）────────────────────────────────────────────
	dhjxk_zhengbei: {
		audio: false,
		persevereSkill: true,
		group: ["dhjxk_zhengbei_lose", "dhjxk_zhengbei_slot"],
		// ①「无法被视为【兵粮寸断】的目标」。
		//    引擎里「能不能对某角色用某张牌」最后都过 targetEnabled，
		//    而 mod 是挂在**目标**身上的（同 mobile 的〖凭吊英士〗用
		//    get.type(card) == "delay" 挡掉所有延时锦囊），这里只挡兵粮寸断。
		mod: {
			targetEnabled(card, player, target) {
				if (target.hasSkill("dhjxk_zhengbei") && card.name == "binliangcunduan") {
					return false;
				}
			},
		},
	},

	// ②「回合外失去你区域内的牌时，可以弃一张牌并摸一张」。
	//    「此牌不计入本技能」= 因本技能弃掉的那张不能反过来再触发本技能，
	//    用一个 busy 标记把这段窗口关掉（弃置是同步发生的，标记来得及生效）。
	dhjxk_zhengbei_lose: {
		audio: false,
		charlotte: true,
		sourceSkill: "dhjxk_zhengbei",
		trigger: { player: "loseEnd" },
		filter(event, player) {
			if (player.storage.dhjxk_zhengbei_busy) {
				return false;
			}
			if (_status.currentPhase == player) {
				return false;
			}
			return ["hs", "es", "js"].some(key => (event[key] || []).length > 0);
		},
		// 同盾牌：走 cost + content。busy 标记必须在 cost 期间（弃置真正发生的那一刻）
		// 就立起来，否则「为发动本技能而弃的那张牌」会再触发一次本技能。
		async cost(event, trigger, player) {
			player.storage.dhjxk_zhengbei_busy = true;
			try {
				event.result = await player
					.chooseToDiscard(get.prompt("dhjxk_zhengbei"), "he", "是否弃置一张牌并摸一张牌？")
					.set("ai", card => 6 - get.value(card))
					.forResult();
			} finally {
				delete player.storage.dhjxk_zhengbei_busy;
			}
		},
		async content(event, trigger, player) {
			await player.draw(1);
		},
	},

	// ③「你的区域无法被任意形式废置」。
	//    装备栏废除走 disableEquip（slots 清空即可让 content 直接 return），
	//    判定区废除走 disableJudge（那边没有 slots，只能 finish 掉整个事件）。
	//    两个都用 Begin 时机，赶在 content 之前下手。
	dhjxk_zhengbei_slot: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_zhengbei",
		trigger: { player: ["disableEquipBegin", "disableJudgeBegin"] },
		async content(event, trigger, player) {
			if (trigger.name == "disableEquip") {
				if (!(trigger.slots || []).length) {
					return;
				}
				trigger.slots = [];
				game.log(player, "的区域无法被废除");
			} else {
				trigger.finish();
				game.log(player, "的判定区无法被废除");
			}
		},
	},

	// ── 黑钢（主公技）────────────────────────────────────────────
	//
	// 「其他角色于其出牌阶段可以给你X张武器牌」——这类主公技的标准骨架见
	// mobile 的〖居相〗（twjuxiang）：主技能只挂 zhuSkill + global，
	// 真正能被别人点开的是一个注册成全局技能的子技能，
	// 用 target.hasZhuSkill("黑钢", player) 确认「给的那位确实是主公」。
	dhjxk_heigang: {
		audio: false,
		zhuSkill: true,
		global: "dhjxk_heigang_global",
	},
	dhjxk_heigang_global: {
		audio: false,
		enable: "phaseUse",
		filter(event, player) {
			if (!player.countCards("he", card => get.subtype(card, false) == "equip1")) {
				return false;
			}
			return game.hasPlayer(target => target != player && target.hasZhuSkill("dhjxk_heigang", player));
		},
		filterCard(card, player) {
			return get.subtype(card, false) == "equip1";
		},
		selectCard: [1, Infinity],
		position: "he",
		filterTarget(card, player, target) {
			return target != player && target.hasZhuSkill("dhjxk_heigang", player);
		},
		async content(event, trigger, player) {
			const target = event.target;
			const num = event.cards.length;
			await player.give(event.cards, target);
			// 谁来选？描述写的是「你（主公）可以选择一项」，所以由主公拍板
			const result = await target
				.chooseControl("选项一", "选项二")
				.set("prompt", get.prompt("dhjxk_heigang", player))
				.set("choiceList", [
					`令${get.translation(player)}视为使用${get.cnNumber(num)}张【无中生有】`,
					`令${get.translation(player)}回复${get.cnNumber(num)}点体力`,
				])
				.set("ai", () => (player.isDamaged() ? "选项二" : "选项一"))
				.forResult();
			target.logSkill("dhjxk_heigang", player);
			if (result.control == "选项二") {
				await player.recover(num);
				return;
			}
			for (let i = 0; i < num; i++) {
				if (!player.isIn()) {
					break;
				}
				await player.useCard(get.autoViewAs({ name: "wuzhongshengyou" }, []), player);
			}
		},
		ai: {
			order: 6,
			result: {
				target: 1,
			},
		},
	},

	// ── 家族（使命技）────────────────────────────────────────────
	//
	// 「当你的第六回合开始时，查看你装备区的牌。成功：当你的装备区拥有4张牌时，
	//   你的各装备栏上限加1；失败：你获得场上一张装备牌并摸两张牌。」
	// 作者已确认：第六回合开始时**一次性**判定，不是之后随时达标都算。
	dhjxk_jiazu: {
		audio: false,
		dutySkill: true,
		group: ["dhjxk_jiazu_count", "dhjxk_jiazu_check"],
	},

	// 记自己这是第几个回合
	dhjxk_jiazu_count: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "dhjxk_jiazu",
		trigger: { player: "phaseBegin" },
		async content(event, trigger, player) {
			player.storage.dhjxk_jiazu_round = (player.storage.dhjxk_jiazu_round || 0) + 1;
		},
	},

	// 第六个回合开始时结算使命
	dhjxk_jiazu_check: {
		audio: false,
		charlotte: true,
		forced: true,
		sourceSkill: "dhjxk_jiazu",
		trigger: { player: "phaseBegin" },
		filter(event, player) {
			return (player.storage.dhjxk_jiazu_round || 0) == 6;
		},
		async content(event, trigger, player) {
			player.logSkill("dhjxk_jiazu");
			delete player.storage.dhjxk_jiazu_round;
			const es = player.getCards("e");
			if (es.length) {
				await player.showCards(es, `${get.translation(player)}【家族】查看装备区的牌`);
			}
			if (es.length >= 4) {
				game.log(player, "成功完成使命");
				player.awakenSkill("dhjxk_jiazu");
				// 「各装备栏上限加1」就是引擎的扩展装备栏：
				// expandEquip 会让 countEnabledSlot 每个栏各 +1
				await player.expandEquip(["equip1", "equip2", "equip3", "equip4", "equip5"]);
				return;
			}
			game.log(player, "使命失败");
			player.awakenSkill("dhjxk_jiazu");
			const result = await player
				.chooseTarget("家族：获得场上一张装备牌", (card, player2, target) => target != player2 && target.countCards("e") > 0)
				.set("ai", target => -get.attitude(player, target))
				.forResult();
			if (result.bool) {
				await player.gainPlayerCard(result.targets[0], "e", true);
			}
			await player.draw(2);
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 琪露诺（魏 / 3体力）
	//
	// 作者给的原文：
	//   智慧 在你的回合内/外，所有其他武将/你每失去1张牌，你抽1张牌。
	//        每名角色每回合首次触发该效果时，你对其造成1点伤害。
	//   冰精 锁定技，你造成的伤害视为冰属性伤害。
	//        你可以将三张牌当无距离次数限制的冰【杀】使用或打出。
	//
	// 【智慧】前半句的两半（「其他武将」/「你」）是同一条规则的两种落点 ——
	// 落点始终是**那张被失去的牌的主人**，只是按「你有没有在回合内」切换看谁；
	// 后半句的「该效果」指的就是前半句那个「失去牌 → 你抽牌」的触发，
	// 所以「每回合首次」是**按角色**算的，不是按技能算的。
	//
	// 【冰精】拆成两半：把伤害改写成冰属性（触发技），
	// 以及「三张牌当冰【杀】」的视为技（主技能）+ 它的三条加成（子技能 mod）。
	// ══════════════════════════════════════════════════════════════

	// ── 智慧 ─────────────────────────────────────────────────────
	// 锁定技，没有「要不要发动」这一问，所以 forced + locked。
	// 但它是个**高频**触发（全场每一次失去牌都会来），所以：
	//   · silent / popup 压掉每一次的动画与提示（惯例同初雪【雪景】）；
	//   · logSkill 只在真正「发动」的那一下显式调用（每角色每回合第一次），
	//     不然每一次掉牌都跳一次技能名，屏幕会糊掉。
	qlno_zhihui: {
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		// 作者没给语音素材，走静音（惯例同涤火杰西卡：宁可 audio:false，
		// 也不要指一个永远 404 的路径）
		audio: false,
		trigger: { global: "loseAfter" },
		filter(event, player) {
			const loser = event.player;
			// 阵亡结算里的弃牌不再算（人已经走了）
			if (!loser || !loser.isAlive()) {
				return false;
			}
			// 「在你的回合内 → 所有其他武将」/「在你的回合外 → 你」
			const mine = _status.currentPhase == player;
			if (mine ? loser == player : loser != player) {
				return false;
			}
			// 还要真的丢了牌（装备进装备区这种「换个区域」不算）
			return qlnoGenuineLost(event, loser) > 0;
		},
		// 没有选项可点，所以不写 cost —— 引擎对 forced 的技能会直接跑 content
		async content(event, trigger, player) {
			const loser = trigger.player;
			const key = qlnoCountKey(loser);
			// 每回合每名角色记一笔账。计数直接挂在**自己主技能的 storage** 上，
			// 不另开隐藏技能当容器 —— 这里只需要一个「本回合该角色来过几次」的
			// 布尔，主技能自己就够用。
			//
			// ★ 这个计数每个回合都会归零，靠的是引擎自己的 stat 层：
			//   content.js 的 phaseLoop 每进一个角色的回合，会给**所有人**
			//   push 一层新的 stat（那一步不在 if (isRound) 里），
			//   而 player.getStat(key) 读的正是最新那一层。
			//   所以「每名角色每回合首次」不需要自己安排清理时机。
			const stat = player.getStat("skill");
			const first = !(stat.qlno_zhihui_lost && stat.qlno_zhihui_lost[key]);
			if (first) {
				if (!stat.qlno_zhihui_lost) {
					stat.qlno_zhihui_lost = {};
				}
				stat.qlno_zhihui_lost[key] = true;
				// 这是「真正发动」的那一下：播报 + 语音 + 动画都归它
				player.logSkill("qlno_zhihui", loser);
			}
			// 「每失去1张牌，你抽1张牌」
			const num = qlnoGenuineLost(trigger, loser);
			if (num > 0) {
				await player.draw(num);
			}
			// 「每名角色每回合首次触发该效果时，你对其造成1点伤害」。
			// 这次伤害也在【冰精】的覆盖范围内（你造成的伤害 → 冰属性）。
			if (first && loser.isAlive()) {
				await loser.damage({ num: 1, source: player });
			}
		},
	},

	// ── 冰精 ─────────────────────────────────────────────────────
	// 主技能 = 「三张牌当冰【杀】使用或打出」的视为技。
	//
	// enable 用数组同时挂两个时机：
	//   "chooseToUse"     —— 出牌阶段当【杀】用
	//   "chooseToRespond" —— 被要求出【杀】时（【南蛮入侵】【决斗】等）打出
	// checkEnable 对数组是 `some`（见 player.js），所以两个场合都亮得起来。
	//
	// 子技能 qlno_bingjing_ice / qlno_bingjing_sha 分别承担「伤害视为冰属性」
	// 与「无距离 / 无次数」加成，用 group 引进来、charlotte 藏住，
	// 技能栏里因此只剩一个【冰精】。
	// （「防止冰属性伤害改弃两张」那一半不需要子技能 —— 引擎的全局规则技
	//   icesha_skill 已经负责了，见下面 qlno_bingjing_ice 的注释。）
	qlno_bingjing: {
		audio: false,
		locked: true,
		enable: ["chooseToUse", "chooseToRespond"],
		group: ["qlno_bingjing_ice", "qlno_bingjing_sha"],
		filter(event, player) {
			// 只有凑得够 3 张牌才亮得起（selectCard 是恰好 3 张）
			return player.countCards("he") >= 3;
		},
		selectCard: 3,
		position: "he",
		filterCard: () => true,
		// ★ 这个 storage 标记是那两条「无距离 / 无次数」mod 的判据
		//   （见 qlnoIsBingjingSha），所以必须由 viewAs 亲自挂上。
		viewAs: (cards, player) => ({ name: "sha", nature: "ice", storage: { qlno_bingjing: true } }),
		prompt: "将三张牌当冰【杀】使用或打出",
		ai: {
			order: 4,
			result: {
				// 三张换一张【杀】，按牌本身的价值掂量（【杀】的收益由引擎的
				// get.effect_use 照常算，这里只报「本技能的额外取向」）
				player: 1,
			},
		},
	},

	// 【冰精】①：把**你造成的所有伤害**改写成冰属性。
	//
	// 写法对着官方离线包〖幼龙〗的 `shinin_youlong`：
	// 它在 `damageBegin` 里调 `game.setNature(trigger, "ice")`。
	// `game.setNature` 就是引擎给「改一张牌 / 一个事件的属性」准备的 API
	// （见 game/index.js），比手写 `trigger.nature = ...` 稳 ——
	// 它内部会走 get.nature 归一化，还顺手处理「属性为空就 delete」。
	//
	// ★★ 这一句同时也是「你造成的所有冰伤害都可以防止、改为弃置目标两张牌」的**全部前提**：
	//   那条规则**引擎早就做成了全局规则技**，这里再写一份就是同一件事问两遍
	//   （实机症状：打一点冰伤弹出两个「是否防止并弃牌」的窗口）。来源链条：
	//     · `card/standard.js` 的 `sha` 卡带 `global: "icesha_skill"`
	//     · 牌堆里**第一次出现【杀】**时，`Card.init` 会执行
	//           game.addGlobalSkill(info.global);  delete info.global;
	//       （见 library/element/card.js 第 299 行）—— 于是它进了 `lib.skill.global`，
	//       对**所有**角色生效，与是谁的技能无关。
	//     · `icesha_skill` 本身是 `inherit: "hanbing_skill"`（寒冰剑）换上
	//           trigger: { source: "damageBegin3" }
	//           filter:  event.hasNature("ice") && event.notLink() && event.player.getCards("he").length > 0
	//       也就是：**任何**冰属性伤害（不论渠道是不是【冰杀】）都能防止并改弃两张。
	//   所以只要把伤害染成冰属性，整条规则就自动接上 —— 提示、结算、AI 评分都归引擎。
	//
	//   唯一的差别：官方那条带 `notLink()`，**铁索连环传导出来的冰伤害不会被防止**。
	//   这是官方规则本身的口径；要连传导一起管，就得自己接一份并让引擎那条让位，
	//   代价大于收益（这一条实机踩过：自己接一份的直接后果就是弹两次）。
	qlno_bingjing_ice: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "qlno_bingjing",
		trigger: { source: "damageBegin" },
		filter(event, player) {
			// 已经是冰属性的不用再动（也免得每次伤害都跑一遍 setNature）
			return !event.hasNature("ice");
		},
		async content(event, trigger, player) {
			game.setNature(trigger, "ice");
		},
	},

	// 【冰精】的加成子技能，全是 mod，本身没有发动时机。
	//
	// ★ 两条加成要分辨「这张【杀】是不是冰精变的」，判据是**主技能 viewAs
	//   亲手挂在虚拟牌上的 `storage.qlno_bingjing`**（见 qlnoIsBingjingSha）。
	//   为什么不靠 `event.skill`：`mod.cardUsable` / `mod.targetInRange` 拿到的
	//   只有 `card`，手上根本没有那个事件；而 storage 是跟着牌走的，
	//   选目标、查次数、真正结算这三个时刻它在同一张牌上都读得到。
	//   （那两条 mod 的拥有者也只可能是「正在用这张牌的人」，所以
	//     问到的永远是琪露诺自己，不会误判到别人身上。）
	qlno_bingjing_sha: {
		audio: false,
		charlotte: true,
		sourceSkill: "qlno_bingjing",
		mod: {
			// 「无距离限制」——必须在**选目标**时生效，targetInRange 就是引擎
			// 判定距离的那个 mod（返回 true 即「在我攻击范围内」）。
			targetInRange(card, player, target) {
				if (qlnoIsBingjingSha(card)) {
					return true;
				}
			},
			// 「无次数限制」——引擎的判定是 player.countUsed(card) < num
			// （见 library/index.js 的 lib.filter.cardUsable），返回 Infinity 恒成立。
			// 注意必须返回 number：返回非 number 会被引擎当 boolean 直接取用。
			cardUsable(card, player, num) {
				if (qlnoIsBingjingSha(card)) {
					return Infinity;
				}
			},
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 均 · 相见欢（魏 / 3体力）
	//
	// 作者原文见 素材/_待实现/均1/描述.txt。四个技能围绕「签」这一枚**牌标记**转：
	//   【音律】每轮一次，把自己的手牌塞给一个人当「签」，从此可以调控他的阶段顺序；
	//   【掷签】转换技。「签」一进弃牌堆就翻面：绿头给自己一个额外阶段，
	//           红头把它变成一张【杀】，然后这张牌被收到自己的武将牌上；
	//   【五阶】武将牌上攒满五张「签」就觉醒，获得【断案】；
	//   【惊堂】限定技，弃牌阶段结束时从下家起逐个逼人表态。
	//
	// ★「签」为什么用 gaintag 而不是 player.storage —— 见文件上方 XJH_QIAN 的说明。
	// ★ 四个技能都没有配音素材，统一 audio: false。
	// ══════════════════════════════════════════════════════════════

	// ── 音律 ──────────────────────────────────────────────────────
	// ① 每轮开始时限一次：展示一张手牌，交给一名角色，称为「签」；
	// ② 拥有「签」的角色，在回合外不能打出或弃置它（由全局技能 xjh_qian 承担）；
	// ③ 拥有「签」的角色回合开始时，均可以调控他的阶段顺序。
	xjh_yinlv: {
		audio: false,
		// `round` 是引擎给触发技准备的「每轮限 N 次」计数
		// （见 library/index.js 的 filterTrigger），logSkill 时自动写 _roundcount
		round: 1,
		group: ["xjh_yinlv_order"],
		init(player, skill) {
			// 「签」的封锁必须是**全局技能**：签在谁手上就得封谁，
			// 挂在均身上封不住别人。注册点放在这里而不是 main/content.js，
			// 是因为 content 跑在角色包 loadCharacter 之前，那时
			// lib.skill.xjh_qian 还不存在，addGlobalSkill 会静默失败。
			// addGlobalSkill 是幂等的，两处都留着也没关系。
			game.addGlobalSkill("xjh_qian");
		},
		trigger: { global: "roundStart" },
		filter(event, player) {
			return player.countCards("h") > 0 && game.hasPlayer(current => current.isIn());
		},
		async content(event, trigger, player) {
			const cardResult = await player
				.chooseCard({
					prompt: "音律：展示一张手牌，将其交给一名角色，称为「签」",
					position: "h",
				})
				.set("ai", card => 1 - get.value(card))
				.forResult();
			if (!cardResult.bool || !cardResult.cards || !cardResult.cards.length) {
				return;
			}
			const card = cardResult.cards[0];
			const targetResult = await player
				.chooseTarget("音律：选择一名角色，将「签」交给他", true, (card2, player2, target) => target != player2)
				.forResult();
			if (!targetResult.bool || !targetResult.targets.length) {
				return;
			}
			const target = targetResult.targets[0];
			await player.showCards([card], "音律：展示的「签」");
			player.line(target, "green");
			await target.gain(card, player);
			// ★ gaintag 要在牌真正落到他手里之后再打
			//   （player.addGaintag 只在 getCards("hejsx") 里的牌上生效）
			target.addGaintag(card, XJH_QIAN);
			game.log(player, "将一张「签」交给了", target);
		},
	},

	// ③ 有「签」的人回合开始时，均可以调控他的阶段顺序
	xjh_yinlv_order: {
		audio: false,
		charlotte: true,
		sourceSkill: "xjh_yinlv",
		trigger: { global: "phaseBegin" },
		filter(event, player) {
			if (event.player == player || !event.player.isIn()) {
				return false;
			}
			// 「签」在哪个区域都算数 —— 手牌、装备区、判定区都行（作者确认：
			// 不限于手牌）。判据本来就长在牌自己身上（gaintag），没理由只翻手牌。
			if (!event.player.countCards("hej", card => xjhIsQian(card))) {
				return false;
			}
			// 得先确认这个时机还够得着本回合的 phase 事件，否则改了也没用
			return !!(event.getParent("phase") || xjhPhaseEvent());
		},
		async cost(event, trigger, player) {
			event.result = await player
				.chooseBool(`音律：是否调控${get.translation(trigger.player)}本回合的阶段顺序？`)
				.set("ai", () => true)
				.forResult();
		},
		async content(event, trigger, player) {
			// phase 事件在 content 里照样顺着事件链找得到，不必往 storage 里塞事件对象
			const phase = trigger.getParent("phase") || xjhPhaseEvent();
			if (!phase) {
				return;
			}
			const order = await xjhChoosePhaseOrder(player, "音律");
			if (!order) {
				return;
			}
			if (xjhReorderPhase(phase, order)) {
				game.log(
					player,
					"调控了",
					trigger.player,
					"的阶段顺序：",
					order.map(name => XJH_PHASE_TEXT[name]).join(" → ")
				);
			}
		},
	},

	// ② 「签」的封锁（全局技能）
	xjh_qian: {
		audio: false,
		charlotte: true,
		mod: {
			// cardEnabled 和 cardRespondable 都会先查 cardEnabled2
			// （见 library/index.js 的 lib.filter），所以这一条同时封住「使用」和「打出」
			cardEnabled2(card) {
				if (xjhQianSealed(card)) {
					return false;
				}
			},
			// 自己弃置（出牌阶段弃牌、各种「弃置一张牌」的代价）
			cardDiscardable(card) {
				if (xjhQianSealed(card)) {
					return false;
				}
			},
			// 别人弃置 / 拿走（【过河拆桥】【顺手牵羊】走的是 canBeDiscarded）
			canBeDiscarded(card) {
				if (xjhQianSealed(card)) {
					return false;
				}
			},
			// 濒死求桃时也不能拿它当【桃】用
			cardSavable(card) {
				if (xjhQianSealed(card)) {
					return false;
				}
			},
		},
	},

	// ── 掷签（转换技）─────────────────────────────────────────────
	// 当「签」进入弃牌堆时：
	//   绿头 —— 你可以执行自己的额外一个阶段；
	//   红头 —— 你可以视为对一名除失去此「签」以外的角色打出一张【杀】。
	// 然后你将此「签」置于自己的武将牌上。
	xjh_zhiqian: {
		audio: false,
		// 转换技三件套：zhuanhuanji 开关 + mark 标记 + intro 说明当前在哪一面
		zhuanhuanji: true,
		mark: true,
		marktext: "签",
		intro: {
			content(storage, player) {
				return !storage
					? "绿头：你可以执行自己的额外一个阶段。"
					: "红头：你可以视为对一名除失去此「签」以外的角色打出一张【杀】。";
			},
		},
		trigger: { global: "loseAfter" },
		filter(event, player) {
			const cards = xjhQianDiscarded(event);
			if (!cards.length) {
				return false;
			}
			// filter 里先存好，content 直接取，省得再猜一遍
			player.storage.xjh_zhiqian_cards = cards;
			player.storage.xjh_zhiqian_from = event.player || null;
			return true;
		},
		async cost(event, trigger, player) {
			event.result = await player
				.chooseBool(get.prompt("xjh_zhiqian"), "是否发动【掷签】？")
				.set("ai", () => true)
				.forResult();
		},
		async content(event, trigger, player) {
			const cards = player.storage.xjh_zhiqian_cards || [];
			const from = player.storage.xjh_zhiqian_from;
			delete player.storage.xjh_zhiqian_cards;
			delete player.storage.xjh_zhiqian_from;
			if (!cards.length) {
				return;
			}
			if (!player.storage[event.name]) {
				// 绿头：执行自己的额外一个阶段
				const result = await player
					.chooseControl(XJH_PHASES)
					.set("prompt", "掷签（绿头）：选择你要额外执行的一个阶段")
					.set(
						"choiceList",
						XJH_PHASES.map(name => XJH_PHASE_TEXT[name])
					)
					.set("ai", () => "phaseUse")
					.forResult();
				const name = result && XJH_PHASES.includes(result.control) ? result.control : "phaseUse";
				await xjhInsertPhase(player, name, "xjh_zhiqian");
				game.log(player, "将额外执行一个", XJH_PHASE_TEXT[name]);
			} else {
				// 红头：视为对一名角色打出一张【杀】（不能是失去这张签的人）
				const result = await player
					.chooseTarget(
						"掷签（红头）：视为对一名角色打出一张【杀】",
						(card, me, target) => target != me && target != from && target.isIn()
					)
					.set("ai", target => get.effect(target, { name: "sha" }, player, player))
					.forResult();
				if (result.bool && result.targets && result.targets.length) {
					await player
						.useCard(get.autoViewAs({ name: "sha" }, []), result.targets)
						.set("addCount", false);
				}
			}
			// 然后把这个「签」收上自己的武将牌
			const next = player.addToExpansion(cards, player);
			next.gaintag.add(XJH_QIAN);
			await next;
			game.log(player, "将「签」置于了武将牌上");
			player.changeZhuanhuanji(event.name);
		},
	},

	// ── 五阶（觉醒技）─────────────────────────────────────────────
	// 当你的武将牌上累计五张「签」时，你获得【断案】。
	xjh_wujie: {
		audio: false,
		juexingji: true,
		skillAnimation: true,
		animationColor: "orange",
		// addToExpansionAfter 是引擎给「牌被放上武将牌」准备的时机
		trigger: { player: "addToExpansionAfter" },
		forced: true,
		filter(event, player) {
			return player.countExpansions(XJH_QIAN) >= 5;
		},
		async content(event, trigger, player) {
			player.awakenSkill("xjh_wujie");
			await player.addSkills("xjh_duanan");
		},
		derivation: ["xjh_duanan"],
	},

	// ── 断案（五阶给出来的衍生技）─────────────────────────────────
	// 每轮限一次，你可以弃置一枚「签」，令一名其他角色少执行一个阶段，
	// 或令你多执行一个阶段。
	xjh_duanan: {
		audio: false,
		enable: "phaseUse",
		// ★ 引擎的 `round` 字段只在 filterTrigger 里判，对 enable 型主动技不生效，
		//   所以「每轮限一次」得自己按 game.roundNumber 记
		filter(event, player) {
			return player.hasExpansions(XJH_QIAN) && xjhRoundFree(player, "xjh_duanan");
		},
		async content(event, trigger, player) {
			const cards = player.getExpansions(XJH_QIAN);
			const cardResult = await player
				.chooseButton(["断案：弃置一枚「签」", [cards, "card"]], true)
				.forResult();
			if (!cardResult.bool || !cardResult.links || !cardResult.links.length) {
				return;
			}
			await player.loseToDiscardpile(cardResult.links[0]);
			xjhMarkRound(player, "xjh_duanan");
			const result = await player
				.chooseControl("选项一", "选项二")
				.set("prompt", get.prompt("xjh_duanan"))
				.set("choiceList", ["令一名其他角色少执行一个阶段", "令你多执行一个阶段"])
				.set("ai", () => "选项一")
				.forResult();
			if (!result || !result.control) {
				return;
			}
			const phaseResult = await player
				.chooseControl(XJH_PHASES)
				.set("prompt", "断案：选择要调整的阶段")
				.set(
					"choiceList",
					XJH_PHASES.map(name => XJH_PHASE_TEXT[name])
				)
				.set("ai", () => "phaseUse")
				.forResult();
			const name = phaseResult && phaseResult.control;
			if (!name || !XJH_PHASES.includes(name)) {
				return;
			}
			if (result.control == "选项一") {
				const targetResult = await player
					.chooseTarget("断案：令一名其他角色少执行一个阶段", true, (card2, me, target) => target != me)
					.forResult();
				if (!targetResult.bool || !targetResult.targets.length) {
					return;
				}
				const target = targetResult.targets[0];
				player.line(target, "thunder");
				// skipList 是引擎自己的跳过机制：阶段事件轮到自己时 checkSkipped 掉它。
				// 本回合那个阶段已经跑过的话，这一跳会留到下回合 —— 正是原文的「顺延」
				// （详见文件上方 XJH_PHASES 那段说明）
				target.skip(name);
				game.log(target, "将少执行一个", XJH_PHASE_TEXT[name]);
			} else {
				await xjhInsertPhase(player, name, "xjh_duanan");
				game.log(player, "将额外执行一个", XJH_PHASE_TEXT[name]);
			}
		},
		ai: {
			order: 7,
			result: { player: 1 },
		},
	},

	// ── 惊堂（限定技）─────────────────────────────────────────────
	// 弃牌阶段结束时，你从下家开始，依次让场上角色选择一项：
	// ① 展示一张手牌，将其视为「签」；② 交给你 x 张牌（x 为上家交出的数量）。
	// 作者补充：x 至少为 1。
	xjh_jingtang: {
		audio: false,
		limited: true,
		skillAnimation: true,
		animationColor: "gray",
		trigger: { player: "phaseDiscardAfter" },
		filter(event, player) {
			return game.hasPlayer(current => current != player && current.isIn());
		},
		async cost(event, trigger, player) {
			event.result = await player
				.chooseBool(get.prompt("xjh_jingtang"), "是否发动【惊堂】？")
				.set("ai", () => true)
				.forResult();
		},
		async content(event, trigger, player) {
			player.awakenSkill(event.name);
			const list = game.players.slice();
			const index = list.indexOf(player);
			const order = index < 0 ? list.slice() : list.slice(index + 1).concat(list.slice(0, index));
			// 「x 为上家交出数量」，作者补了一句：x 至少为 1
			let x = 1;
			for (const target of order) {
				if (target == player || !target.isIn()) {
					continue;
				}
				const canReveal = target.countCards("h") > 0;
				const canGive = target.countCards("he") >= x;
				if (!canReveal && !canGive) {
					continue;
				}
				const choiceList = [
					"展示一张手牌，将其视为「签」",
					`交给${get.translation(player)}${get.cnNumber(x)}张牌`,
				];
				const controls = [];
				if (canReveal) {
					controls.push("选项一");
				}
				if (canGive) {
					controls.push("选项二");
				}
				let pick = controls[0];
				if (controls.length > 1) {
					const result = await target
						.chooseControl(controls)
						.set("prompt", `惊堂：请选择一项（交给${get.translation(player)}的牌数为${get.cnNumber(x)}）`)
						.set("choiceList", choiceList)
						.set(
							"ai",
							() =>
								get.attitude(target, player) < 0 && target.countCards("h") > 0 ? "选项一" : "选项二"
						)
						.forResult();
					pick = result && result.control ? result.control : controls[0];
				} else {
					game.log(target, "只能选择", choiceList[controls[0] == "选项一" ? 0 : 1]);
				}
				if (pick == "选项一") {
					if (!canReveal) {
						continue;
					}
					const cardResult = await target
						.chooseCard({ prompt: "惊堂：展示一张手牌，将其视为「签」", position: "h" })
						.forResult();
					if (!cardResult.bool || !cardResult.cards || !cardResult.cards.length) {
						continue;
					}
					const card = cardResult.cards[0];
					await target.showCards([card], "惊堂：展示的「签」");
					target.addGaintag(card, XJH_QIAN);
					game.log(target, "获得了一张「签」");
					// 选了展示就不交牌，轮到下一家时 x 回到下限
					x = 1;
					continue;
				}
				if (!canGive) {
					continue;
				}
				const giveResult = await target
					.chooseCard({
						prompt: `惊堂：交给${get.translation(player)}${get.cnNumber(x)}张牌`,
						position: "he",
						selectCard: x,
					})
					.forResult();
				if (!giveResult.bool || !giveResult.cards || !giveResult.cards.length) {
					x = 1;
					continue;
				}
				await target.give(giveResult.cards, player);
				x = Math.max(1, giveResult.cards.length);
			}
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 均 · 律法（魏 / 3体力）
	//
	// 作者原文见 素材/_待实现/均2/描述.txt。
	//
	// 【定法】是一个「立一条法、两轮内人人遵守」的规则技：
	// 每到你回合开始，你从十条里挑一条，它在接下来的**两轮**里对全场（含你自己）
	// 生效；违反的人失去 1 点体力。十条各自是一个**全局技能**——
	// 规则要管到每一个人，挂在均身上就只管得住他自己。
	//
	// ★ 数据放在 `player.storage.lf_dingfa_rules` 里，形如
	//     [{ rule: 3, until: 5 }, ...]
	//   until 记的是「到第几轮为止」（game.roundNumber 是当轮轮数）。
	//   同一轮里重复立同一条不会叠成两层，只把到期时间往后推。
	//
	// ★ 十条的落地口径（原文只说了「违反则失去一点体力」，没说能不能违反）：
	//   能自动做的（摸牌数增减、击杀后弃光手牌）直接做成效果；
	//   要花钱的（弃一张牌、弃一张手牌）做成**强制**的询问，付不出就失去 1 点体力；
	//   是禁令或上限的（不可出【杀】、不可弃超过三张、酒后不可出杀）就按禁令执行，
	//   违反了才罚 —— 引擎拦不住「玩家非要出杀」，罚一点体力正是原文的意思。
	//
	// ★ 第 ⑩ 条「你使用技能时，需弃置一张牌」是个例外：无名杀没有任何
	//   「使用技能」的通用时机（引擎的 useSkill 事件只有两处调用点），
	//   所以这里包了一层 player.logSkill —— 它是所有技能发动的必经之路。
	//   这是本扩展继 lib.filter.cardSavable / game.playAudio 之后的第三处核心包装。
	// ══════════════════════════════════════════════════════════════

	// ── 定法（持恒技）─────────────────────────────────────────────
	lf_dingfa: {
		audio: false,
		persevereSkill: true,
		mark: true,
		marktext: "法",
		intro: {
			content(storage, player) {
				const list = lfRuleActive(player);
				if (!list.length) {
					return "当前没有生效的律法。";
				}
				return list
					.map(rule => `㊣ ${LF_RULE_TEXT[rule - 1]}`)
					.join("<br>");
			},
		},
		trigger: { player: "phaseBegin" },
		filter(event, player) {
			return player.isIn();
		},
		init(player, skill) {
			// 十条规则各是一个全局技能（理由见上面的说明）
			for (let i = 1; i <= 10; i++) {
				game.addGlobalSkill(`lf_dingfa_r${i}`);
			}
			lfHookLogSkill();
		},
		async content(event, trigger, player) {
			const choiceList = LF_RULE_TEXT.map((text, i) => `${get.cnNumber(i + 1)}、${text}`);
			const result = await player
				.chooseControl(
					LF_RULE_TEXT.map((text, i) => `选项${i + 1}`),
					"cancel2"
				)
				.set("prompt", get.prompt("lf_dingfa"))
				.set("choiceList", choiceList)
				.set("ai", () => "选项1")
				.forResult();
			if (!result || !result.control || result.control == "cancel2") {
				return;
			}
			const rule = parseInt(result.control.replace("选项", ""), 10);
			if (!(rule >= 1 && rule <= 10)) {
				return;
			}
			const list = (player.storage.lf_dingfa_rules || []).filter(item => item.until >= game.roundNumber);
			const found = list.find(item => item.rule == rule);
			if (found) {
				found.until = game.roundNumber + 1;
			} else {
				list.push({ rule, until: game.roundNumber + 1 });
			}
			player.storage.lf_dingfa_rules = list;
			player.markSkill("lf_dingfa");
			game.log(player, `立下律法「${LF_RULE_TEXT[rule - 1]}」，两轮内全场有效`);
		},
	},

	// ① 摸牌阶段多摸两张牌，回合内不可打出【杀】
	lf_dingfa_r1: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: ["phaseDrawBegin2", "useCardAfter"] },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player, name) {
			if (!lfHasRule(player, 1)) {
				return false;
			}
			// ★ 分辨「这一次是哪个时机」一律用 filter 的第三个参数（= triggername），
			//   不要拿 event.name 去猜 —— 那是事件名，phaseBegin / phaseDrawBegin2
			//   这类全是时机名，两者的对应关系不是一个字符串（详见说明.md 同名章节）
			if (name == "phaseDrawBegin2") {
				return !event.numFixed;
			}
			return _status.currentPhase == player && !!event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			if (event.triggername == "phaseDrawBegin2") {
				trigger.num += 2;
				game.log(player, "因律法多摸了两张牌");
				return;
			}
			game.log(player, "违反了律法「回合内不可打出【杀】」");
			await player.loseHp(1);
		},
	},

	// ② 摸牌阶段少摸一张牌
	lf_dingfa_r2: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "phaseDrawBegin2" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 2) && !event.numFixed && event.num > 0;
		},
		async content(event, trigger, player) {
			trigger.num = Math.max(0, trigger.num - 1);
			game.log(player, "因律法少摸了一张牌");
		},
	},

	// ③ 击杀角色时需弃置所有手牌
	lf_dingfa_r3: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { source: "dieAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 3) && player.countCards("h") > 0;
		},
		async content(event, trigger, player) {
			game.log(player, "因律法弃置了所有手牌");
			await player.discard(player.getCards("h"));
		},
	},

	// ④ 装备装备牌时，需弃一张牌
	lf_dingfa_r4: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "equipEnd" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 4);
		},
		async content(event, trigger, player) {
			await lfPayCard(player, "装备了装备牌", "he");
		},
	},

	// ⑤ 使用锦囊牌时，需弃一张牌
	lf_dingfa_r5: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "useCardAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 5) && !!event.card && get.type(event.card) == "trick";
		},
		async content(event, trigger, player) {
			await lfPayCard(player, "使用了锦囊牌", "he");
		},
	},

	// ⑥ 弃牌阶段，不可弃置大于三张牌
	//    原文只给了禁令，没说违反怎么办；这里干脆做成硬上限（弃牌阶段最多弃三张），
	//    因为「违反则失去体力」在引擎里既拦不住也没法事后统计。
	lf_dingfa_r6: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "phaseDiscard" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 6);
		},
		async content(event, trigger, player) {
			// phaseDiscard 的 num 在这一步之前刚算好，而真正用它是在下一步，
			// 所以这里改得动（trigger 的父事件才是那个 phaseDiscard 事件）
			const evt = trigger.getParent("phaseDiscard");
			if (evt && evt !== trigger && typeof evt.num == "number" && evt.num > 3) {
				evt.num = 3;
				game.log(player, "因律法至多只能弃置三张牌");
			}
		},
	},

	// ⑦ 使用【酒】后不可出【杀】
	lf_dingfa_r7: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: ["useCardAfter", "phaseAfter"] },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player, name) {
			if (!lfHasRule(player, 7)) {
				return false;
			}
			if (name == "phaseAfter") {
				return !!player.storage.lf_dingfa_jiu;
			}
			return !!event.card;
		},
		async content(event, trigger, player) {
			if (event.triggername == "phaseAfter") {
				delete player.storage.lf_dingfa_jiu;
				return;
			}
			// ★ content 里的 trigger 才是那个真事件，event 是技能自己的事件 ——
			//   所以要拿牌得问 trigger.card，不是 event.card
			const card = trigger.card;
			if (!card) {
				return;
			}
			if (card.name == "jiu") {
				player.storage.lf_dingfa_jiu = true;
				return;
			}
			if (card.name == "sha" && player.storage.lf_dingfa_jiu) {
				delete player.storage.lf_dingfa_jiu;
				game.log(player, "违反了律法「使用【酒】后不可出【杀】」");
				await player.loseHp(1);
			}
		},
	},

	// ⑧ 累计使用三张锦囊牌时，需直接进入弃牌阶段
	lf_dingfa_r8: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "useCardAfter" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			if (!lfHasRule(player, 8)) {
				return false;
			}
			if (_status.currentPhase != player || !event.card || get.type(event.card) != "trick") {
				return false;
			}
			return !!event.getParent("phaseUse");
		},
		async content(event, trigger, player) {
			const phaseUse = trigger.getParent("phaseUse");
			if (!phaseUse || phaseUse.skipped) {
				return;
			}
			const used = player.getHistory(
				"useCard",
				evt => evt.getParent("phaseUse") == phaseUse && evt.card && get.type(evt.card) == "trick"
			);
			if (used.length < 3) {
				return;
			}
			// 引擎自己的「本阶段到此为止」开关：phaseUse 的 content 下一步
			// 就是 `if (result.bool && !event.skipped) event.goto(3)`，置真即离场
			phaseUse.skipped = true;
			game.log(player, "因律法直接进入了弃牌阶段");
		},
	},

	// ⑨ 当你对他人造成伤害时，需弃置一张手牌
	lf_dingfa_r9: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { source: "damageSource" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			return lfHasRule(player, 9) && event.player != player;
		},
		async content(event, trigger, player) {
			await lfPayCard(player, "对他人造成了伤害", "h");
		},
	},

	// ⑩ 你使用技能时，需弃置一张牌
	//
	// 规则本身走 logSkill 包装（见 lfHookLogSkill / lfDingfaSkillTax，
	// 由 lf_dingfa 的 init 安装）。这里留一个空壳技能，只是为了让它
	// 有一份名字与翻译，好在技能表与日志里说得清是哪一条。
	lf_dingfa_r10: {
		audio: false,
		charlotte: true,
		sourceSkill: "lf_dingfa",
		trigger: { player: "phaseBegin" },
		// 真正的逻辑在 lfDingfaSkillTax 里（logSkill 包装）；这里留一个空的 content
		// 只是为了过「技能必须有 content」那条校验，filter 恒假所以永远不会跑
		filter() {
			return false;
		},
		async content(event, trigger, player) {},
	},

	// ── 音乐 ──────────────────────────────────────────────────────
	// 出牌阶段限一次，你可以弃置一张黑色锦囊牌，
	// 并视为对至多四名角色使用【铁索连环】。
	// 作者确认：自选至多四人，可以少于四人，也可以只连一个。
	lf_yinyue: {
		audio: false,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			return player.countCards("he", card => get.type(card) == "trick" && get.color(card) == "black") > 0;
		},
		filterCard(card) {
			return get.type(card) == "trick" && get.color(card) == "black";
		},
		position: "he",
		selectCard: 1,
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget(
					"音乐：视为对至多四名角色使用【铁索连环】",
					[1, 4],
					(card, me, target) => target.isIn()
				)
				.set("ai", target => get.effect(target, { name: "tiesuo" }, player, player))
				.forResult();
			if (!result.bool || !result.targets || !result.targets.length) {
				return;
			}
			// ★ 铁索连环本身只允许 1~2 个目标，这里直接给 useCard 一份目标数组
			//   绕开选目标阶段的合法性检查（结算阶段本来就不核对数量）
			await player
				.useCard(get.autoViewAs({ name: "tiesuo" }, []), result.targets)
				.set("addCount", false);
		},
		ai: {
			order: 6,
			result: { player: 1 },
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 重岳 · 登临意（魏 / 3体力）
	//
	// 作者原文见 素材/_待实现/重岳/描述.txt。
	//
	// 【戍边】是觉醒技 + 蓄力技（1/3）：
	//   · `chargeSkill: 3` 让引擎建出「蓄力」标记与上限（player.getMaxCharge 会累加
	//     所有技能上的 chargeSkill 字段），显示与计数全归引擎；
	//   · 出牌阶段每用一张【杀】蓄力 +1；蓄满 3 点立刻清空，视为对攻击范围内的
	//     至多两名角色各使用一张不计次数的【杀】；
	//   · 每个目标自己选：伤害 +1 且无视其防具 / 伤害 -1 并把「戍」压进他的判定区；
	//   · 以此法累计打出 1/2/3 张【杀】时，依次觉醒【镇乾】【定坤】【为家】。
	//
	// ★ 技能表里第一个技能名写的是【镇坤】，但正文同一条效果写的是【镇乾】——
	//   作者已确认**以【镇乾】为准**，技能表是笔误。
	// ★「戍」的判定区占用是这么做的：进场时先把判定区清空再 `disableJudge()`，
	//   离场时 `enableJudge()`。`lib.filter.judge` 第一句就是
	//   `target.canAddJudge(card, player)`，而它开头就查 isDisabledJudge()，
	//   所以废置判定区就等于「判定区不可放置其他牌或标记」。
	// ══════════════════════════════════════════════════════════════

	// ── 戍边（觉醒技 + 蓄力技）───────────────────────────────────
	zy_shubian: {
		audio: false,
		juexingji: true,
		chargeSkill: 3,
		skillAnimation: true,
		animationColor: "orange",
		group: ["zy_shubian_charge", "zy_shubian_hit"],
		mod: {
			// 「你的【杀】次数+1」：引擎判的是 countUsed(card) < num，返回 num+1 即可
			cardUsable(card, player, num) {
				if (card.name == "sha") {
					return num + 1;
				}
			},
		},
	},

	// 出牌阶段每出一张【杀】蓄力 +1；蓄满就炸
	zy_shubian_charge: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		sourceSkill: "zy_shubian",
		trigger: { player: "useCardAfter" },
		filter(event, player) {
			if (_status.currentPhase != player || !event.card || event.card.name != "sha") {
				return false;
			}
			return player.countCharge() < player.getMaxCharge();
		},
		async content(event, trigger, player) {
			player.addCharge(1);
			if (player.countCharge() < player.getMaxCharge()) {
				return;
			}
			player.removeCharge(Infinity);
			player.logSkill("zy_shubian");
			const result = await player
				.chooseTarget(
					"戍边：蓄力已满，视为对攻击范围内的至多两名角色各使用一张【杀】",
					[1, 2],
					(card, me, target) => target != me && target.isIn() && me.inRange(target)
				)
				.set("ai", target => get.effect(target, { name: "sha" }, player, player))
				.forResult();
			if (!result.bool || !result.targets || !result.targets.length) {
				return;
			}
			const targets = result.targets.slice();
			// 每个目标自己选一项，结果写进这张虚拟【杀】的 storage，
			// 由 zy_shubian_unequip 在伤害结算时读 —— 挂在牌上就不需要事后清理
			const mods = {};
			for (const target of targets) {
				if (!target.isIn()) {
					continue;
				}
				const choice = await target
					.chooseControl("选项一", "选项二")
					.set("prompt", `戍边：${get.translation(player)}的【杀】指定了你，请选择一项`)
					.set("choiceList", [
						"此【杀】伤害+1，且无视你的防具",
						"此【杀】伤害-1，并将一枚「戍」置于你的判定区",
					])
					.set("ai", () => (target.hp > 2 ? "选项二" : "选项一"))
					.forResult();
				if (choice && choice.control == "选项一") {
					mods[target.playerid] = 1;
				} else {
					mods[target.playerid] = -1;
					await zyShuPlace(player, target);
				}
			}
			const card = get.autoViewAs({ name: "sha" }, []);
			card.storage = card.storage || {};
			card.storage.zy_shubian = {
				mods,
				up: Object.keys(mods).filter(id => mods[id] > 0),
			};
			await player.useCard(card, targets).set("addCount", false);
			// 「以此法打出 1/2/3 张【杀】时，依次获得镇乾/定坤/为家」
			const num = (player.storage.zy_shubian_count || 0) + targets.length;
			player.storage.zy_shubian_count = num;
			for (const [need, skill] of [
				[1, "zy_zhenqian"],
				[2, "zy_dingkun"],
				[3, "zy_weijia"],
			]) {
				if (num >= need && !player.hasSkill(skill)) {
					await player.addSkills(skill);
					game.log(player, "觉醒了", `【${get.translation(skill)}】`);
				}
			}
		},
	},

	// ── 镇乾 ──────────────────────────────────────────────────────
	// 锁定技。你受到和打出【杀】的伤害+1，你使用【杀】无距离限制。
	//
	// ★「打出【杀】的伤害」按「你使用的【杀】造成的伤害」理解
	//   （打出是响应，本来就不造成伤害），两条伤害加成拆成两个子技能。
	zy_zhenqian: {
		audio: false,
		locked: true,
		group: ["zy_zhenqian_out", "zy_zhenqian_in"],
		mod: {
			targetInRange(card, player, target) {
				if (card.name == "sha") {
					return true;
				}
			},
		},
	},
	// 你使用的【杀】造成的伤害+1
	zy_zhenqian_out: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "zy_zhenqian",
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			return event.num > 0 && !event.unreal && !!event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},
	// 你受到【杀】的伤害+1
	zy_zhenqian_in: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "zy_zhenqian",
		trigger: { player: "damageBegin1" },
		filter(event, player) {
			return event.num > 0 && !event.unreal && !!event.card && event.card.name == "sha";
		},
		async content(event, trigger, player) {
			trigger.num += 1;
		},
	},

	// 戍边那一刀的两种修正：伤害 ±1 / 无视防具。
	//
	// 修正数据挂在**那张虚拟【杀】的 storage 上**（由 zy_shubian_charge 在 useCard
	// 之前写进去），所以不需要事后清理 —— 牌用完就没了，也不会串到下一张【杀】上。
	zy_shubian_hit: {
		audio: false,
		charlotte: true,
		silent: true,
		popup: false,
		sourceSkill: "zy_shubian",
		trigger: { source: "damageBegin1" },
		filter(event, player) {
			const info = event.card && event.card.storage && event.card.storage.zy_shubian;
			if (!info || !event.player) {
				return false;
			}
			return typeof info.mods[event.player.playerid] == "number";
		},
		async content(event, trigger, player) {
			const info = trigger.card && trigger.card.storage && trigger.card.storage.zy_shubian;
			if (!info) {
				return;
			}
			const num = info.mods[trigger.player.playerid];
			trigger.num = Math.max(0, trigger.num + num);
		},
		ai: {
			// 「无视防具」靠 unequip 这个 skillTag 实现（同青釭剑、思衡托〖拒止〗）
			unequip: true,
			unequip_ai: true,
			skillTagFilter(player, tag, arg) {
				// 有的调用点传 { card, target }，有的直接把牌递进来，两种都兜住
				let card = arg;
				let target = null;
				if (arg && typeof arg == "object" && arg.card) {
					card = arg.card;
					target = arg.target;
				}
				const info = card && card.storage && card.storage.zy_shubian;
				if (!info || !info.up || !info.up.length) {
					return false;
				}
				return target ? info.up.includes(target.playerid) : true;
			},
		},
	},

	// ── 「戍」（压在被指定者身上的标记）──────────────────────────
	//
	// 它不是重岳的技能，而是【戍边】给目标 addSkill 上去的：
	//   · 判定区被占满（disableJudge），显示成一枚 mark；
	//   · 目标回合开始时须交给重岳一张【杀】，交不出来则本回合他打重岳的伤害 -1；
	//   · 目标回合结束时移除，并把判定区还回去。
	zy_shu: {
		audio: false,
		charlotte: true,
		mark: true,
		marktext: "戍",
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "zy_shubian",
		intro: {
			content: "回合开始时须交给重岳一张【杀】，否则本回合对重岳造成的伤害-1；回合结束时移除。",
		},
		trigger: { player: ["phaseBegin", "phaseJieshuAfter"], source: "damageBegin3" },
		async content(event, trigger, player) {
			if (event.triggername == "damageBegin3") {
				const owner = zyShuOwner(player);
				if (owner && trigger.player == owner && player.storage.zy_shu_weak) {
					trigger.num = Math.max(0, trigger.num - 1);
				}
				return;
			}
			if (event.triggername == "phaseJieshuAfter") {
				delete player.storage.zy_shu_owner;
				delete player.storage.zy_shu_weak;
				player.removeSkill("zy_shu");
				await player.enableJudge();
				game.log(player, "移除了「戍」");
				return;
			}
			// phaseBegin：须交给重岳一张【杀】
			const owner = zyShuOwner(player);
			if (!owner || !owner.isIn()) {
				delete player.storage.zy_shu_owner;
				delete player.storage.zy_shu_weak;
				player.removeSkill("zy_shu");
				await player.enableJudge();
				return;
			}
			const result = await player
				.chooseCard({
					prompt: `戍：交给${get.translation(owner)}一张【杀】，否则本回合你对其造成的伤害-1`,
					position: "he",
					filterCard: card => card.name == "sha",
				})
				.set("ai", () => 1)
				.forResult();
			if (result.bool && result.cards && result.cards.length) {
				player.storage.zy_shu_weak = false;
				await player.give(result.cards, owner);
			} else {
				player.storage.zy_shu_weak = true;
				game.log(player, "未交出【杀】，本回合对", owner, "造成的伤害-1");
			}
		},
	},

	// ── 定坤 ──────────────────────────────────────────────────────
	// 锁定技。你不可响应【杀】，你使用【杀】无次数限制。
	zy_dingkun: {
		audio: false,
		locked: true,
		mod: {
			// 「无次数限制」：引擎判 countUsed(card) < num，返回 Infinity 恒成立
			// （必须返回 number，返回非 number 会被引擎当 boolean 直接取用）
			cardUsable(card, player, num) {
				if (card.name == "sha") {
					return Infinity;
				}
			},
			// 「不可响应【杀】」：cardRespondable 是引擎给「能否打出这张牌响应」
			// 准备的 mod（见 library/index.js 的 lib.filter.cardRespondable）。
			// 时机上只能看到 _status.event，所以从 chooseToRespond 往上找是不是在响应【杀】。
			cardRespondable(card, player) {
				if (card.name != "shan") {
					return;
				}
				let evt = _status.event;
				for (let i = 0; i < 20 && evt; i++) {
					if (evt.name == "sha" || (evt.card && evt.card.name == "sha")) {
						return false;
					}
					evt = evt.parent;
				}
			},
		},
	},

	// ── 为家 ──────────────────────────────────────────────────────
	// 每个回合限一次，你可以将一张♠牌当作任意非延时锦囊牌使用。
	//
	// 「任意非延时锦囊牌」在无名杀里没有让玩家手输牌名的输入框，
	// 所以借用引擎现成的印卡界面：get.inpileVCardList 列出牌堆里所有牌，
	// 按 type == "trick" 过滤掉基本牌 / 装备牌 / 延时锦囊，再用
	// chooseButton + backup 那套（与杜预【灭吴】、张让同源）让玩家点一张。
	zy_weijia: {
		audio: false,
		locked: true,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			if (!player.countCards("he", card => get.suit(card) == "spade")) {
				return false;
			}
			return get.inpileVCardList(info => info[0] == "trick").length > 0;
		},
		chooseButton: {
			dialog(event, player) {
				const list = get.inpileVCardList(info => info[0] == "trick");
				return ui.create.dialog("为家：将一张♠牌当作一张非延时锦囊牌使用", [list, "vcard"]);
			},
			// 手里得真有♠牌，这个按钮才该亮起来
			filter(button, player) {
				return player.countCards("he", card => get.suit(card) == "spade") > 0;
			},
			check(button) {
				return get.player().getUseValue({ name: button.link[2], nature: button.link[3] });
			},
			backup(links, player) {
				return {
					audio: false,
					popname: true,
					log: false,
					selectCard: 1,
					position: "he",
					filterCard(card) {
						return get.suit(card) == "spade";
					},
					viewAs: { name: links[0][2], nature: links[0][3] },
				};
			},
			prompt(links, player) {
				return `将一张♠牌当作${get.translation(links[0][2])}使用`;
			},
		},
		// 引擎会把上面的 backup() 写进这个技能（同 wsde_liming_sha 的写法）
		subSkill: {
			backup: {},
		},
		ai: {
			order: 7,
			result: { player: 1 },
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 颉 · 辞岁行（魏 / 3体力）
	//
	// 作者原文见 素材/_待实现/颉/描述.txt。
	//
	// 【正史】记账：开局一枚「史」，之后「装备牌进弃牌堆 / 有人死亡 / 有人脱离濒死 /
	//   有人使用限定技」各加一枚；花一枚史可以从弃牌堆里捞一张**装备牌**装备上
	//   （作者确认：原文「非装备牌」是笔误），然后翻牌堆顶一张 ——
	//   是装备牌就送给别人，否则扣在自己武将牌上，叫「损」。
	// 【书刀】视为装备着一把不可移除的武器（攻击距离 2），
	//   用它指定的每个目标都可以被「令此牌对其无效并移除其一个装备区」，
	//   或者花一枚史让这张牌不可被响应。
	// 【明哲】使命技：史先到「场上人数」算成功（获得【保身】），
	//   损先到 5 张算失败（立即失去所有体力）。
	// 【诀别】作者已同意**先跳过**（「维持濒死状态」在无名杀里做不到）。
	//
	// ★「视为装备着书刀」用的是引擎的 extraEquip 机制（同藤甲的 addExtraEquip）：
	//   它是一张**虚拟装备**，不进任何区域，所以「不可被移除」是白送的 ——
	//   根本没有实体牌可以被弃置、被拿走或被替换掉。
	//   代价是虚拟装备不会自己提供牌上的技能，所以攻击距离与使用牌的效果
	//   都得由技能本体（mod + group）承担。
	// ★「史」用 player 标记（addMark/markSkill），「损」是武将牌上的实体牌
	//   （addToExpansion + gaintag），两者的载体不同是有意的：
	//   损要能被数出来、能被翻开看到，史只需要一个计数。
	// ══════════════════════════════════════════════════════════════

	// ── 正史 ──────────────────────────────────────────────────────
	jie_zhengshi: {
		audio: false,
		locked: true,
		enable: "phaseUse",
		mark: true,
		marktext: "史",
		intro: {
			content: "mark",
			markcount: "mark",
		},
		group: ["jie_zhengshi_start", "jie_zhengshi_equip", "jie_zhengshi_die", "jie_zhengshi_dying", "jie_zhengshi_limited", "jie_zhengshi_out"],
		filter(event, player) {
			if (jieShiCount(player) <= 0) {
				return false;
			}
			return jieZhengshiPool(player).length > 0;
		},
		async content(event, trigger, player) {
			const cards = jieZhengshiPool(player);
			const result = await player
				.chooseButton(["正史：弃置一枚「史」，从弃牌堆中选择一张非装备牌，视为使用之", [cards, "card"]], true)
				.forResult();
			if (!result.bool || !result.links || !result.links.length) {
				return;
			}
			player.removeMark(JIE_SHI, 1);
			const card = result.links[0];
			// 「以此法使用的牌移出游戏」—— 标记打在牌身上，由 jie_zhengshi_out
			// 在它落进弃牌堆的那一刻收尾。为什么不在这里直接送走：延时锦囊使用时
			// 是进判定区的，当场抽走等于连【乐不思蜀】的效果一起取消掉。
			if (card.storage) {
				card.storage.jie_zhengshi_out = true;
			}
			// 「视为使用」—— 不先拿进手里再打出去，直接把它当作颉使用的一张牌来结算。
			// chooseUseTarget 会替她选好目标；牌的位置（弃牌堆 → 处理区 → 弃牌堆）
			// 由引擎自己处理，用不着手动 gain / equip。
			await player.chooseUseTarget(card, true, "nopopup");
			// 翻牌堆顶的一张牌
			const top = get.cards(1)[0];
			if (!top) {
				return;
			}
			game.log(player, "翻开了牌堆顶的一张牌", top);
			player.popup(get.translation(top.name));
			if (get.type(top) == "equip") {
				const give = await player
					.chooseTarget("正史：将这张装备牌交给一名其他角色", (card2, me, target) => target != me && target.isIn())
					.forResult();
				if (give.bool && give.targets.length) {
					player.line(give.targets[0], "green");
					await give.targets[0].gain(top, player);
				} else {
					// 没人可给就塞回牌堆顶，别把牌弄丢
					ui.cardPile.insertBefore(top.fix(), ui.cardPile.firstChild);
				}
			} else {
				const next = player.addToExpansion([top], player);
				next.gaintag.add(JIE_SUN);
				await next;
				game.log(player, "将其扣置在武将牌上，称为「损」");
				await jieCheckMingzhe(player);
			}
		},
		ai: {
			order: 6,
			result: { player: 1 },
		},
	},

	// 「以此法使用的牌移出游戏」
	//
	// 时机挑 loseAfter 而不是在使用那一刻：牌用完会先落进弃牌堆（延时锦囊还得等
	// 判定结算完），在这里把它从弃牌堆里提出来扔进 ui.special，从此不参与游戏 ——
	// 也不会被任何人再捞回去。
	jie_zhengshi_out: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "loseAfter" },
		filter(event, player) {
			return jieZhengshiOut(event).length > 0;
		},
		async content(event, trigger, player) {
			const cards = jieZhengshiOut(trigger);
			for (const card of cards) {
				delete card.storage.jie_zhengshi_out;
			}
			game.log(player, "将", cards, "移出了游戏");
			await game.cardsGotoSpecial(cards);
		},
	},

	// 开局一枚「史」
	jie_zhengshi_start: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "gameStart" },
		async content(event, trigger, player) {
			await jieAddShi(player, "游戏开始");
		},
	},

	// 每有一张装备牌进入弃牌堆
	jie_zhengshi_equip: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "loseAfter" },
		filter(event, player) {
			return jieEquipDiscarded(event) > 0;
		},
		async content(event, trigger, player) {
			const num = jieEquipDiscarded(trigger);
			for (let i = 0; i < num; i++) {
				await jieAddShi(player, "装备牌进入弃牌堆");
			}
		},
	},

	// 一名角色死亡
	jie_zhengshi_die: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "dieAfter" },
		async content(event, trigger, player) {
			await jieAddShi(player, "一名角色死亡");
		},
	},

	// 一名角色脱离濒死
	jie_zhengshi_dying: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "dyingAfter" },
		filter(event, player) {
			return event.player && event.player.isAlive() && event.player.hp > 0;
		},
		async content(event, trigger, player) {
			await jieAddShi(player, "一名角色脱离濒死");
		},
	},

	// 一名角色使用限定技
	//
	// ★ 引擎没有「使用限定技」的时机，但限定技**一定**会调 player.awakenSkill，
	//   所以这里包一层 awakenSkill 来记账（只包一次，幂等）。
	jie_zhengshi_limited: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "jie_zhengshi",
		trigger: { global: "phaseBegin" },
		init(player, skill) {
			if (game.__arknightsAwakenHooked || !lib.element || !lib.element.player || !lib.element.player.awakenSkill) {
				return;
			}
			game.__arknightsAwakenHooked = true;
			const awakenSkill = lib.element.player.awakenSkill;
			lib.element.player.awakenSkill = function (name, ...rest) {
				const before = Array.isArray(this.awakenedSkills) ? this.awakenedSkills.includes(name) : true;
				const result = awakenSkill.apply(this, [name, ...rest]);
				try {
					const info = lib.skill[name];
					if (!before && info && info.limited) {
						jieNotifyLimited(this);
					}
				} catch (e) {
					// 记账失败不该把游戏带崩
				}
				return result;
			};
		},
		// 这个子技能本身不做周期检查，只为让 awakenSkill 包装有个安装点
		filter() {
			return false;
		},
		async content(event, trigger, player) {},
	},

	// ── 书刀（持恒技）─────────────────────────────────────────────
	jie_shudao: {
		audio: false,
		persevereSkill: true,
		group: ["jie_shudao_use"],
		init(player, skill) {
			// 视为装备着一把虚拟的「书刀」（第三个参数 true = 先清掉本技能的旧视为装备）
			player.addExtraEquip(skill, JIE_SHOUDAO, true);
		},
		onremove(player, skill) {
			player.removeExtraEquip(skill);
		},
		mod: {
			// 虚拟装备不会自己提供攻击距离，得由技能补：书刀攻击距离 2
			attackRange(player, num) {
				return Math.max(num, 2);
			},
		},
	},

	// 「当你使用牌指定一名玩家时」的二选一
	jie_shudao_use: {
		audio: false,
		charlotte: true,
		equipSkill: true,
		sourceSkill: "jie_shudao",
		trigger: { player: "useCardToPlayered" },
		filter(event, player) {
			return !!event.target && event.target != player && event.target.isIn();
		},
		async cost(event, trigger, player) {
			const target = trigger.target;
			const cardText = get.translation(trigger.card);
			const choiceList = [
				`令${cardText}对${get.translation(target)}无效，并移除其一个装备区`,
				`弃置一枚「史」，令${cardText}不可被响应`,
			];
			const list = ["选项一"];
			if (jieShiCount(player) > 0) {
				list.push("选项二");
			} else {
				choiceList[1] = `<span style="opacity:0.5">${choiceList[1]}</span>`;
			}
			event.result = await player
				.chooseControl(list, "cancel2")
				.set("prompt", get.prompt("jie_shudao", target))
				.set("choiceList", choiceList)
				.set("ai", () => "选项一")
				.forResult();
			// ★ cost 的 result **不会**被递给 content（引擎只转交 result.cost_data），
			//   所以选择结果得自己经 storage 转手（同涤火杰西卡【盾牌】的写法）
			player.storage.jie_shudao_pick = event.result && event.result.control;
		},
		async content(event, trigger, player) {
			const target = trigger.target;
			const pick = player.storage.jie_shudao_pick;
			delete player.storage.jie_shudao_pick;
			if (pick == "选项一") {
				// 「使此牌对其无效」：useCard 的 excluded 数组就是逐目标结算时的黑名单，
				// 而四个 useCardToXxx 时机都排在那个检查**之前**，这里加得进去
				const use = trigger.getParent("useCard");
				if (use && Array.isArray(use.excluded)) {
					use.excluded.add(target);
				}
				game.log(trigger.card, "对", target, "无效");
				// 再移除目标的一个装备区
				const slots = ["equip1", "equip2", "equip3", "equip4", "equip5"].filter(
					slot => !target.disabledSlots || !target.disabledSlots[slot]
				);
				if (!slots.length) {
					return;
				}
				const slotText = {
					equip1: "武器区",
					equip2: "防具区",
					equip3: "进攻坐骑区",
					equip4: "防御坐骑区",
					equip5: "宝物区",
				};
				const result = await player
					.chooseControl(slots)
					.set("prompt", `书刀：移除${get.translation(target)}的一个装备区`)
					.set(
						"choiceList",
						slots.map(slot => slotText[slot] || slot)
					)
					.set("ai", () => slots[0])
					.forResult();
				if (result && result.control && slots.includes(result.control)) {
					await target.disableEquip(result.control);
					game.log(player, "移除了", target, "的", slotText[result.control] || result.control);
				}
				return;
			}
			if (pick == "选项二" && jieShiCount(player) > 0) {
				player.removeMark(JIE_SHI, 1);
				trigger.directHit.add(target);
				game.log(player, "弃置一枚「史」，令", trigger.card, "不可被响应");
			}
		},
	},

	// ── 明哲（使命技）─────────────────────────────────────────────
	//
	// 判定本身在 jieCheckMingzhe 里，由【正史】的每一处记账顺手调用；
	// 这个技能自己只留一个回合开始的兜底复查（万一有别的渠道改了史/损的数量）。
	jie_mingzhe: {
		audio: false,
		dutySkill: true,
		trigger: { global: "phaseBegin" },
		forced: true,
		silent: true,
		popup: false,
		async content(event, trigger, player) {
			await jieCheckMingzhe(player);
		},
	},

	// ── 保身（明哲成功后获得）─────────────────────────────────────
	// 若弃牌区有一张与被使用牌花色、牌名均相同的牌，
	// 你可以弃置一枚「史」，使其无效并进入弃牌区。
	jie_baoshen: {
		audio: false,
		trigger: { target: "useCardToTargeted" },
		filter(event, player) {
			if (jieShiCount(player) <= 0) {
				return false;
			}
			const card = event.card;
			if (!card || !card.name) {
				return false;
			}
			const suit = get.suit(card);
			return jieDiscardPile().some(c => c.name == card.name && get.suit(c) == suit);
		},
		async cost(event, trigger, player) {
			event.result = await player
				.chooseBool(get.prompt("jie_baoshen", trigger.card), "是否弃置一枚「史」，令此牌无效？")
				.set("ai", () => get.effect(player, trigger.card, trigger.player, player) < 0)
				.forResult();
		},
		async content(event, trigger, player) {
			player.removeMark(JIE_SHI, 1);
			const use = trigger.getParent("useCard");
			if (use && Array.isArray(use.excluded)) {
				use.excluded.add(player);
			}
			game.log(trigger.card, "对", player, "无效");
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 黍 · 怀黍离（魏 / 3体力）
	//
	// 作者原文见 素材/_待实现/黍/描述.txt。
	//
	// 两枚标记都长在**别人的武将牌**上（实体牌 + gaintag，理由同颉的「损」）：
	//   「种」= shu_zhong，扣置着的一张基本牌；「禾」= shu_he，翻过面的那一张。
	// 作者确认：「每名角色的种、禾的上限**共用**为 1」。
	//
	// 【春种】出牌阶段限一次（作者改稿）：塞一张基本牌给某人当「种」。持有者回合
	//   开始时，要么再搭一张基本牌，让这一对「种」分头落到离他最近的两名（身上还没有黍标记的）角色那儿；
	//   要么这张「种」就地翻面成「禾」，并让黍回复 1 点体力。
	// 【秋收】持恒技：摸牌阶段可以用场上的「禾」换等量的牌；
	//   手牌上限 + 禾数；对有禾的角色用牌无距离限制；有禾的角色与黍算距离 +1。
	// 【枯荣】锁定技：回复溢出体力上限的部分转成护甲；
	//   自己回合开始时若自己武将牌上有禾就回复 1 点体力。
	//
	// ★【春种】那句「将一张基本牌和此『种』当做『种』放置」是这么读的：
	//   持有者额外出一张基本牌手牌，凑成**两张**牌，于是才够分给**两名**角色。
	//   这也正好解释了为什么是「两名」而不是一名。
	// ★ 没有配音素材，全部 audio: false。
	// ══════════════════════════════════════════════════════════════

	// 「种」「禾」的**标记**。
	//
	// 牌本身照旧是实体牌（扣在持有者的武将牌上），但那一排小牌既看不出花色点数，
	// 也没有「这是黍的标记」的样子。于是给持有者挂一个同名技能，让引擎把它当标记显示：
	//   mark: true                   → 在武将牌边上长出一个标记
	//   intro.markcount: "expansion" → 标记上显示张数
	//   intro.content: "expansion"   → 点开/悬停能看到具体是哪张牌
	//
	// ★ 技能名必须和 gaintag **一模一样**：引擎的 expansion 分支是按
	//   `card.hasGaintag(技能名)` 找牌的（get/index.js 的 intro 处理、
	//   player.js 的 updateMarks 同理），名字对不上就只会显示「没有卡牌」。
	shu_zhong: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		mark: true,
		marktext: "种",
		intro: {
			content: "expansion",
			markcount: "expansion",
		},
	},
	shu_he: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		mark: true,
		marktext: "禾",
		intro: {
			content: "expansion",
			markcount: "expansion",
		},
	},

	// ── 春种 ──────────────────────────────────────────────────────
	// 作者改稿：原稿是「每轮限一次，轮次开始时……一张♥牌」，
	// 现在是「出牌阶段限一次……一张基本牌」—— 于是它从一条
	// **回合外自动触发的轮次技**变成了**自己主动发动的出牌阶段技能**。
	//
	// ★ 交互也按作者要求换成了「把一张牌拖到一名角色身上」：
	//   给出 filterCard / selectCard / filterTarget 之后，引擎会把这个技能
	//   当成一张「能用的牌」来走 chooseToUse —— 选牌、点人一步到位，
	//   不再弹「选牌框 → 选人框」两个对话框（同【仁德】那一套）。
	//
	// ★ discard / lose 必须关掉：这张牌既不是弃置、也不是「失去」，
	//   而是被 addToExpansion 挪到别人的武将牌上（它内部自己会调 lose，
	//   见 content.js 的 addToExpansion）。
	shu_chunzhong: {
		audio: false,
		// ★ 黍自己身上不挂「种」标记 —— 「种」长在**别人**的武将牌上，
		//   那一边由 shu_zhong / shu_he 两个 mark 技能负责显示。
		enable: "phaseUse",
		usable: 1,
		group: ["shu_chunzhong_pass"],
		intro: {
			content: "出牌阶段限一次，你可以将一张基本牌扣置到一名角色的武将牌上，称为「种」。拥有「种」的角色回合开始时，需将一张基本牌和此「种」当做「种」放置在相邻最近的两名没有你的其他标记的角色武将牌上；否则此「种」翻面，称为「禾」，并使你回复1点体力。",
		},
		// 选牌与选目标都交给引擎的 chooseToUse，所以「谁能放种」写在 filterTarget 里
		filterCard: shuIsBasic,
		selectCard: 1,
		filterTarget(card, player, target) {
			return shuMarkFree(target);
		},
		discard: false,
		lose: false,
		check(card) {
			// AI 挑牌：给出去的那张越不值钱越好
			return 6 - get.value(card);
		},
		async content(event, trigger, player) {
			const target = event.target;
			const card = event.cards && event.cards[0];
			if (!target || !card) {
				return;
			}
			player.line(target, "green");
			const next = target.addToExpansion([card], player);
			next.gaintag.add(SHU_ZHONG);
			await next;
			// 挂上同名标记技能：武将牌边上就会出现「种」（悬停可见是哪张牌）
			target.addSkill(SHU_ZHONG);
			game.log(player, "在", target, "的武将牌上放置了「种」");
		},
		ai: {
			// 主动技得自己说清「值不值得点」：给出去的是张基本牌，
			// 换来的是一次可能长出来的「禾」，算小赚；顺序放后面，别抢输出。
			order: 1,
			result: { player: 1 },
		},
	},

	// 持有「种」的角色回合开始时，把它传下去；不传就翻面成「禾」
	shu_chunzhong_pass: {
		audio: false,
		charlotte: true,
		sourceSkill: "shu_chunzhong",
		// ★ 不再问黍「是否发动」——「不发动」和下面那个选择里的「不交出」后果
		//   完全一样（「种」翻面成「禾」+ 黍回复1点体力），多问一层纯属多余。
		//   forced 让引擎跳过第一层确认（content.js「info.forced」那条分支），
		//   直接把选择交给持有「种」的角色。
		trigger: { global: "phaseBegin" },
		forced: true,
		filter(event, player) {
			return !!event.player && event.player.isIn() && event.player.hasExpansions(SHU_ZHONG);
		},
		async content(event, trigger, player) {
			const holder = trigger.player;
			// ★ 共用上限改为 3 之后，同一个人身上可能同时扣着好几张「种」——
			//   逐张结算：每张各问一次「交 / 不交」，配得出基本牌就传走、
			//   配不出（或没有去处）就翻面成「禾」。
			const total = holder.countExpansions(SHU_ZHONG);
			for (let i = 0; i < total; i++) {
				// 每轮都重新取第一张：上一张已经传走或翻面，不会重复结算
				const zhong = holder.getExpansions(SHU_ZHONG)[0];
				if (!zhong) {
					break;
				}
				await shuPassOne(holder, zhong, player);
			}
		},
	},

	// ── 秋收（持恒技）─────────────────────────────────────────────
	shu_qiushou: {
		audio: false,
		persevereSkill: true,
		group: ["shu_qiushou_gain", "shu_he_owner_clean"],
		mod: {
			// 「你的手牌上限+x（x为场上禾数量）」
			maxHandcard(player, num) {
				return num + shuHeCount();
			},
			// 「你对有禾的武将打出牌无距离限制」
			targetInRange(card, player, target) {
				if (target && target.isIn() && shuHasHe(target)) {
					return true;
				}
			},
			// 「拥有禾的角色与你计算距离+1」——globalTo 修的正是「别人 → 你」的距离
			globalTo(from, to, distance) {
				if (from && shuHasHe(from)) {
					return distance + 1;
				}
			},
		},
	},

	// 摸牌阶段，你可以移除场上任意张「禾」并摸等量张牌
	shu_qiushou_gain: {
		audio: false,
		charlotte: true,
		sourceSkill: "shu_qiushou",
		trigger: { player: "phaseDrawBegin" },
		filter(event, player) {
			return shuHeCount() > 0;
		},
		async cost(event, trigger, player) {
			const cards = [];
			for (const current of game.players.concat(game.dead || [])) {
				cards.addArray(current.getExpansions(SHU_HE));
			}
			if (!cards.length) {
				event.result = { bool: false };
				return;
			}
			const result = await player
				.chooseButton(
					[`秋收：移除任意张「禾」并摸等量张牌（当前${get.cnNumber(cards.length)}张）`, [cards, "card"]],
					[1, cards.length]
				)
				.forResult();
			event.result = result;
			if (result.bool && result.links) {
				player.storage.shu_qiushou_pick = result.links.slice();
			}
		},
		async content(event, trigger, player) {
			const cards = player.storage.shu_qiushou_pick || [];
			delete player.storage.shu_qiushou_pick;
			if (!cards.length) {
				return;
			}
			const map = new Map();
			for (const card of cards) {
				const owner = get.owner(card);
				if (!owner) {
					continue;
				}
				if (!map.has(owner)) {
					map.set(owner, []);
				}
				map.get(owner).push(card);
			}
			for (const [owner, list] of map) {
				await owner.loseToDiscardpile(list);
			}
			game.log(player, `移除了${get.cnNumber(cards.length)}张「禾」`);
			await player.draw(cards.length);
		},
	},

	// 离开武将牌的「禾」要把归属标注摘掉（秋收移除、持有者阵亡都会走这里）
	shu_he_owner_clean: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "shu_qiushou",
		trigger: { global: "loseAfter" },
		filter(event) {
			return shuHeLeftBoard(event).length > 0;
		},
		async content(event, trigger, player) {
			for (const card of shuHeLeftBoard(trigger)) {
				shuClearHeOwner(card);
			}
		},
	},

	// ── 枯荣（锁定技）─────────────────────────────────────────────
	shu_kurong: {
		audio: false,
		locked: true,
		group: ["shu_kurong_over", "shu_kurong_start"],
		mod: {
			// 满血也能使用【桃】：那 1 点回复会全额溢出，按【枯荣】变成 1 点护甲。
			cardEnabled(card, player) {
				if (card.name == "tao" && player.isHealthy()) {
					return true;
				}
			},
			// 桃是 toself 的牌，目标筛选这一关也得放行
			targetEnabled(card, player, target) {
				if (card.name == "tao" && player == target && target.isHealthy()) {
					return true;
				}
			},
		},
		init() {
			shuPatchRecover();
		},
	},

	// 回复溢出体力上限的部分，等量转成护甲
	shu_kurong_over: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "shu_kurong",
		// recoverBegin 卡在 recover 的 content 之前 —— 那一段一上来就把 num
		// 夹到 maxHp-hp，所以溢出量只有在这之前才读得到
		trigger: { player: "recoverBegin" },
		filter(event, player) {
			return event.num > player.maxHp - player.hp;
		},
		async content(event, trigger, player) {
			const over = trigger.num - (player.maxHp - player.hp);
			if (over > 0) {
				game.log(player, `回复溢出${get.cnNumber(over)}点，转化为护甲`);
				await player.changeHujia(over);
			}
		},
	},

	// 回合开始时，若你的武将牌上有「禾」，你回复 1 点体力
	shu_kurong_start: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "shu_kurong",
		trigger: { player: "phaseBegin" },
		filter(event, player) {
			// 满血也要触发：那 1 点回复会全额溢出，按【枯荣】变成 1 点护甲
			return shuHasHe(player);
		},
		async content(event, trigger, player) {
			await shuRecover(player, 1);
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 塔露拉 · 不死的黑蛇（群 / 3体力）
	// ══════════════════════════════════════════════════════════════
	// 三个技能都没有配音素材，统一 audio: false。

	// ── 燎原 ──────────────────────────────────────────────────────
	// 「造成伤害时」落在伤害结算**之后**（damageAfter）：这一支里还要
	// 「令受伤角色恢复1点体力」，要是提前到伤害之前回复，濒死结算的顺序
	// 就整个错位了。
	tll_liaoyuan: {
		audio: false,
		// 觉醒后 locked / forced 会被【黑蛇】改成 true（「视为锁定技」）
		group: ["tll_liaoyuan_reset"],
		trigger: { global: "damageAfter" },
		init(player, skill) {
			// 「下一张【杀】无距离次数限制」是给**伤害来源**的，谁都有可能，
			// 所以得做成全局技能 —— 挂在自己身上只管得住自己。
			game.addGlobalSkill("tll_liaoyuan_sha");
		},
		filter(event, player) {
			const current = _status.currentPhase;
			if (!current || !event.source || event.source != current) {
				return false;
			}
			if (!event.num || event.num <= 0) {
				return false;
			}
			if ((player.storage.tll_liaoyuan_count || 0) >= tllLiaoyuanMax(player)) {
				return false;
			}
			if (tllStealBranch(player)) {
				// 偷牌那一支：受伤的必须是「你」（配对里「其他角色/你」的后半）
				if (event.player != player) {
					return false;
				}
				// 拿不到牌就整段发动不了 —— 后面跟着一串「若如此做」
				if (tllAwake(player)) {
					return game.hasPlayer(other => other != current && other.isIn() && other.countCards("hej") > 0);
				}
				return current.isIn() && current.countCards("hej") > 0;
			}
			// 摸牌那一支：受伤的得是「其他角色」—— 也就是相对当前回合角色而言
			return event.player != current;
		},
		async content(event, trigger, player) {
			const current = _status.currentPhase;
			const source = trigger.source;
			const victim = trigger.player;
			player.storage.tll_liaoyuan_count = (player.storage.tll_liaoyuan_count || 0) + 1;
			if (tllStealBranch(player)) {
				await tllLiaoyuanSteal(player, current);
			} else {
				// 「与受伤角色各摸1张牌」——若受伤的就是自己，只摸那一张
				await player.draw();
				if (victim != player && victim.isIn()) {
					await victim.draw();
				}
			}
			if (victim.isIn()) {
				await victim.recover(1);
			}
			// 伤害来源抽一张【杀】，并且他下一张【杀】不再受限
			const sha = tllDrawShaFromPile();
			if (sha && source && source.isIn()) {
				game.log(source, "从牌堆中抽到了", sha);
				await source.gain(sha, "gain2");
			}
			if (source && source.isIn()) {
				// ★ 加成是给「下一张【杀】」的。可要是这会儿正有一张【杀】在结算，
				//   那张牌自己的 useCardAfter 还在后头 —— 它一到就会把刚发出去的
				//   标记清掉，「下一张【杀】」于是什么也没拿到。
				//   所以在「正在进行的这次使用」上做个记号，清理时跳过它。
				//
				//   ★ 判据必须看 use.card（这次**使用**的是什么牌），不能看 trigger.card：
				//     技能伤害根本不带牌 —— 【安魂】的自伤就是这么冒出来的
				//     （trigger.card 是空的，而此刻手里那张【杀】正卡在 useCard 里没结算完）。
				//     照 trigger.card 判，记号就打不上，标记会被那张【杀】自己的
				//     useCardAfter 当场收回，于是「下一张【杀】」什么也拿不到。
				const use = trigger.getParent?.("useCard");
				if (use && use.card && get.name(use.card) == "sha") {
					use._tll_liaoyuan_mark = true;
				}
				source.storage.tll_liaoyuan_sha = true;
			}
		},
	},

	// 【燎原】的限次按「每个角色的回合」算，所以得在**每个回合开始时**清零；
	// 【安魂】的濒死回复、【黑蛇】的「回合中首次回复」同理，一并在这儿清掉。
	tll_liaoyuan_reset: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "tll_liaoyuan",
		trigger: { global: "phaseBegin" },
		filter(event, player) {
			return !!(player.storage.tll_liaoyuan_count || player.storage.tll_anhun_count || player.storage.tll_heishe_recovered);
		},
		async content(event, trigger, player) {
			delete player.storage.tll_liaoyuan_count;
			delete player.storage.tll_anhun_count;
			delete player.storage.tll_heishe_recovered;
		},
	},

	// 「伤害来源抽取一张【杀】且下一张【杀】无距离次数限制」的后半句。
	// 全局技能 + 每个人自己的 storage 标记；mod 认的正是拥有者自己。
	tll_liaoyuan_sha: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "tll_liaoyuan",
		trigger: { player: "useCardAfter" },
		filter(event, player) {
			// ★ event._tll_liaoyuan_mark：这张【杀】正是「发标记」的那一张，
			//   它用完不算「下一张」，轮不到它来清。
			return !!player.storage.tll_liaoyuan_sha && get.name(event.card) == "sha" && !event._tll_liaoyuan_mark;
		},
		async content(event, trigger, player) {
			delete player.storage.tll_liaoyuan_sha;
		},
		mod: {
			cardUsable(card, player, num) {
				if (player.storage.tll_liaoyuan_sha && get.name(card) == "sha") {
					return Infinity;
				}
			},
			targetInRange(card, player) {
				if (player.storage.tll_liaoyuan_sha && get.name(card) == "sha") {
					return true;
				}
			},
		},
	},

	// ── 安魂（锁定技）────────────────────────────────────────────
	tll_anhun: {
		audio: false,
		locked: true,
		group: ["tll_anhun_damage", "tll_anhun_dying"],
	},

	// 使用能造成伤害的牌 → 对自己造成1点伤害。
	// ★ 来源必须写成**塔露拉自己**：觉醒后【燎原】认的是「当前回合角色对
	//   『你』造成伤害」，自伤要是不带来源，那一支就永远点不着。
	tll_anhun_damage: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "tll_anhun",
		trigger: { player: "useCard" },
		filter(event, player) {
			const card = event.card;
			if (!card || get.type(card) == "delay") {
				return false;
			}
			return get.name(card) == "sha" || !!get.tag(card, "damage");
		},
		async content(event, trigger, player) {
			await player.damage(1, player);
		},
	},

	// 进入濒死时把体力拉回 1：觉醒前管**回合外**、限一次；觉醒后管**回合内**、
	// 限两次（也就是原文的「颠倒」加上「限制次数+1」）。
	tll_anhun_dying: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "tll_anhun",
		trigger: { player: "dying" },
		filter(event, player) {
			const inner = _status.currentPhase == player;
			if (inner != tllAwake(player)) {
				return false;
			}
			return (player.storage.tll_anhun_count || 0) < tllAnhunMax(player);
		},
		async content(event, trigger, player) {
			player.storage.tll_anhun_count = (player.storage.tll_anhun_count || 0) + 1;
			game.log(player, "将体力值回复至1");
			await player.recover(1 - player.hp);
		},
	},

	// ── 黑蛇（觉醒技）────────────────────────────────────────────
	// 「一名角色死亡前」—— 落在 dieBefore。
	// ★ 正在死的如果就是塔露拉自己，必须在这里把**整段死亡流程**拦掉、再把
	//   体力从 0 拉回来（同结城理换面具那套）。挂在 dieBegin / die 上的话，
	//   判死的动作早就做完了 —— 人已经进了 game.dead、体力归零、手牌弃光、
	//   死亡界面也挂上了，这时候再加体力上限也救不回来，看上去就是「真死了」。
	//   cancel() 之后 die 的 content 一个 step 都不会执行，也就没人替你复活，
	//   所以那一句 revive 不能省（只 cancel 不 revive 会以 0 体力活着、
	//   紧接着再次濒死）。
	tll_heishe: {
		audio: false,
		juexingji: true,
		forced: true,
		// 这两个是给 content 内部后续产生的子事件兜底的（同十常侍【殁亡】）
		forceDie: true,
		direct: true,
		priority: 15,
		skillAnimation: true,
		animationColor: "metal",
		trigger: { global: "dieBefore" },
		filter(event, player) {
			return !player.storage.tll_heishe;
		},
		async content(event, trigger, player) {
			player.awakenSkill("tll_heishe");
			if (trigger.player == player) {
				trigger.cancel();
				player.revive(1, false);
			}
			await player.gainMaxHp();
			if (player.hp < 3) {
				await player.recoverTo(3);
			}
			// 「非限定技视为锁定技」—— 把定义本身改掉，之后【燎原】不再询问。
			// 同名的武将一局只可能有一个，改的就是这一份，牵连不到别人。
			game.broadcastAll(function () {
				const liaoyuan = lib.skill.tll_liaoyuan;
				if (liaoyuan) {
					liaoyuan.locked = true;
					liaoyuan.forced = true;
				}
				const dying = lib.skill.tll_anhun_dying;
				if (dying) {
					dying.locked = true;
				}
			});
			// 「本局游戏，你于回合中首次体力回复量+1」
			// ★ 不能挂进 tll_heishe.group —— awakenSkill 会顺着 group 把整棵
			//   树一起 disable，那样这个子技能刚拿到手就是死的。
			player.addSkill("tll_heishe_recover");
			game.log(player, "颠倒了自己技能中的「内」与「外」");
			tllSwitchAwakeImage(player);
		},
	},

	// 每个自己的回合里，第一次回复体力时回复量 +1
	tll_heishe_recover: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "tll_heishe",
		trigger: { player: "recoverBegin" },
		filter(event, player) {
			return _status.currentPhase == player && !player.storage.tll_heishe_recovered;
		},
		async content(event, trigger, player) {
			player.storage.tll_heishe_recovered = true;
			trigger.num++;
		},
	},

	// ══════════════════════════════════════════════════════════════
	// 年 · 洪炉示岁（魏 / 4体力）
	// ══════════════════════════════════════════════════════════════

	// ── 岁铸（锁定技）────────────────────────────────────────────
	nian_suizhu: {
		audio: false,
		locked: true,
		mod: {
			maxHandcard(player, num) {
				return num + player.countCards("e");
			},
		},
	},

	// ── 洪炉 ──────────────────────────────────────────────────────
	nian_honglu: {
		audio: false,
		enable: "phaseUse",
		usable: 1,
		filter(event, player) {
			return nianHongluOptions(player).length > 0;
		},
		async content(event, trigger, player) {
			const options = nianHongluOptions(player);
			let key;
			if (options.length == 1) {
				key = options[0].key;
			} else {
				const result = await player
					.chooseControl(options.map(option => option.key))
					.set("prompt", "洪炉：选择一项")
					.set("choiceList", options.map(option => option.text))
					.forResult();
				if (!result || !result.control) {
					return;
				}
				key = result.control;
			}
			if (key == "选项一") {
				// ① 自己装备区的一张牌 → 其他角色的装备区（已有同类型则替换）
				const pick = await player.chooseButton(["洪炉：选择要移走的装备", player.getCards("e")], true).forResult();
				if (!pick.bool || !pick.links.length) {
					return;
				}
				const card = pick.links[0];
				if (!game.hasPlayer(current => current != player && current.isIn() && current.canEquip(card))) {
					return;
				}
				const targetResult = await player
					.chooseTarget("洪炉：将该装备置入一名角色的装备区", (card2, me, target) => target != me && target.canEquip(card))
					.forResult();
				if (!targetResult.bool) {
					return;
				}
				const target = targetResult.targets[0];
				player.$give(card, target, false);
				await target.equip(card);
				nianMarkPlaced(card, player);
				game.log(player, "将", card, "置入了", target, "的装备区");
			} else if (key == "选项二") {
				// ② 弃一张牌 → 弃牌区的一张装备牌 → 任意角色的装备区
				const drop = await player.chooseToDiscard("洪炉：弃置一张牌", "he", true).forResult();
				if (!drop.bool) {
					return;
				}
				const pool = [];
				for (const card of ui.discardPile.childNodes) {
					if (get.type(card) == "equip") {
						pool.push(card);
					}
				}
				if (!pool.length) {
					return;
				}
				const pick = await player.chooseButton(["洪炉：选择弃牌区的一张装备牌", pool], true).forResult();
				if (!pick.bool || !pick.links.length) {
					return;
				}
				const card = pick.links[0];
				const targetResult = await player
					.chooseTarget("洪炉：将该装备置入一名角色的装备区", (card2, me, target) => target.canEquip(card))
					.forResult();
				if (!targetResult.bool) {
					return;
				}
				const target = targetResult.targets[0];
				// 先从弃牌区拿到手上，再从手上进装备区 —— equip 的 content 只认
				// 「不在 hejx 里的牌」（见 content.js 的那句 position 判断），
				// 直接对还躺在弃牌堆里的牌调用它，是什么都不会发生的
				await target.gain(card, "gain2");
				await target.equip(card);
				nianMarkPlaced(card, player);
				game.log(player, "将", card, "置入了", target, "的装备区");
			} else {
				// ③ 弃一张牌 → 从牌堆抽一张装备牌
				const drop = await player.chooseToDiscard("洪炉：弃置一张牌", "he", true).forResult();
				if (!drop.bool) {
					return;
				}
				const card = get.cardPile2(item => get.type(item) == "equip", "random");
				if (!card) {
					return;
				}
				card.original = "c";
				ui.cardPile.removeChild(card);
				game.updateRoundNumber();
				game.log(player, "从牌堆中抽到了", card);
				await player.gain(card, "gain2");
			}
		},
		ai: {
			order: 7,
			result: {
				player: 1,
			},
		},
	},

	// ── 锻器（锁定技）────────────────────────────────────────────
	// 两条支线各自独立：武器那半看「用【杀】的人身上有没有你置入的武器」，
	// 防具那半看「成为【杀】目标的人身上有没有你置入的防具」。
	// 两条都写着「你选择一项」，所以只要有一项做得成就必须发动。
	nian_duanqi: {
		audio: false,
		locked: true,
		group: ["nian_duanqi_sha", "nian_duanqi_armor", "nian_duanqi_damage"],
	},

	// 拥有你置入武器的角色使用【杀】时：弃一张手牌令伤害+1 / 弃掉武器摸两张
	nian_duanqi_sha: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		popup: false,
		sourceSkill: "nian_duanqi",
		trigger: { global: "useCard" },
		filter(event, player) {
			if (get.name(event.card) != "sha" || !event.player || !event.player.isIn()) {
				return false;
			}
			return !!nianPlacedWeapon(event.player, player);
		},
		async content(event, trigger, player) {
			const user = trigger.player;
			const weapon = nianPlacedWeapon(user, player);
			if (!weapon) {
				return;
			}
			const key = await nianDuanqiChoose(player, "锻器：选择一项", [
				{ key: "选项一", text: "弃置一张手牌，令此【杀】的伤害+1", ok: player.countCards("h") > 0 },
				{ key: "选项二", text: `弃置${get.translation(user)}装备区的${get.translation(weapon)}，你摸两张牌`, ok: true },
			]);
			if (key == "选项一") {
				const drop = await player.chooseToDiscard("锻器：弃置一张手牌", "h", true).forResult();
				if (!drop.bool) {
					return;
				}
				if (trigger.card.storage) {
					trigger.card.storage.nian_duanqi_buff = true;
				}
				game.log(player, "令", trigger.card, "的伤害+1");
			} else if (key == "选项二") {
				await user.discard(weapon);
				await player.draw(2);
			}
		},
	},

	// 成为【杀】目标的人身上有你置入的防具时：弃一张手牌视为其打出【闪】 /
	// 弃掉防具摸两张牌
	nian_duanqi_armor: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		popup: false,
		sourceSkill: "nian_duanqi",
		trigger: { global: "useCardToTargeted" },
		filter(event, player) {
			if (get.name(event.card) != "sha" || !event.target || !event.target.isIn()) {
				return false;
			}
			return !!nianPlacedArmor(event.target, player);
		},
		async content(event, trigger, player) {
			const target = trigger.target;
			const armor = nianPlacedArmor(target, player);
			if (!armor) {
				return;
			}
			const key = await nianDuanqiChoose(player, "锻器：选择一项", [
				{ key: "选项一", text: `弃置一张手牌，视为${get.translation(target)}打出了【闪】`, ok: player.countCards("h") > 0 },
				{ key: "选项二", text: `弃置${get.translation(target)}装备区的${get.translation(armor)}，你摸两张牌`, ok: true },
			]);
			if (key == "选项一") {
				const drop = await player.chooseToDiscard("锻器：弃置一张手牌", "h", true).forResult();
				if (!drop.bool) {
					return;
				}
				const useCard = trigger.getParent("useCard");
				if (useCard && useCard.excluded) {
					useCard.excluded.add(target);
				}
				game.log(player, "令", target, "视为打出了【闪】");
			} else if (key == "选项二") {
				await target.discard(armor);
				await player.draw(2);
			}
		},
	},

	// 「伤害+1」那一半：标记是打在**那张【杀】自己**身上的，所以这里认的是
	// event.card。顺带在 useCardAfter 把没用上的标记扫掉 —— 这张【杀】要是
	// 被闪了，标记会一直挂在牌上，等它洗回牌堆再被人摸到，就成了一次凭空的加成。
	nian_duanqi_damage: {
		audio: false,
		charlotte: true,
		locked: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "nian_duanqi",
		trigger: { global: ["damageBegin1", "useCardAfter"] },
		filter(event, player) {
			return !!(event.card && event.card.storage && event.card.storage.nian_duanqi_buff);
		},
		async content(event, trigger, player) {
			if (event.triggername == "damageBegin1" && trigger.num > 0) {
				trigger.num++;
			}
			delete trigger.card.storage.nian_duanqi_buff;
		},
	},


// ══ 陈 · 龙门警司（魏 / 4体力）══════════════════════════════════
	// 描述文件：素材\_待实现\陈\描述.txt
	//
	// 原稿有三处歧义，都问过作者了，口径记在这里：
	//   ①【绝影】末尾的「否则你下次由牌造成的伤害+1」= **不发动就白得**：
	//     触发时点取消就直接记下 +1。于是它永远不会空手而归（半个锁定技）。
	//   ②【绝影】挂在**伤害结算之后**（damageAfter），弃牌不干扰伤害流程。
	//   ③【形照】的「任何阶段」是**所有角色的每个小阶段**，不只陈自己的回合。
	chen_jueying: {
		audio: "ext:方舟/skill:2",
		group: ["chen_jueying_buff"],
		// ★ 用 global 而不是 { source, player }：你对自己造成伤害时两个 role 会同时
		//   命中，同一个技能就有被触发两次的风险；global + filter 判断最稳。
		trigger: { global: "damageAfter" },
		filter(event, player) {
			return event.num > 0 && (event.source == player || event.player == player);
		},
		async cost(event, trigger, player) {
			const types = chenOwnedTypes(player);
			if (!types.length) {
				// 身上一张牌都没有 → 没有类型可选，只能吃那 1 点伤害加成
				event.result = { bool: false };
				return;
			}
			// 「取消」就是描述里的那个「否则」——两个选择的后果都写进 choiceList
			const result = await player
				.chooseControl(types.map(type => CHEN_TYPE_TEXT[type]), "cancel2")
				.set("prompt", get.prompt("chen_jueying"))
				.set("prompt2", "选择一种你拥有的牌类型，令伤害来源与受伤角色弃置区域内所有该类型牌；取消则改为你下次由牌造成的伤害+1。")
				.set("choiceList", types.map(type => "令伤害来源与受伤角色弃置区域内所有<b>" + CHEN_TYPE_TEXT[type] + "</b>"))
				.set("ai", () => chenJueyingPick(trigger, player))
				.forResult();
			event.result = result;
			// ★★ cost 的 result **不会**被递给 content：引擎给 content 新建了一个
			//   事件，只转交 result.cards 和 result.cost_data（content.js 的
			//   createTrigger），control 得自己经 storage 转手（同颉【书刀】、
			//   涤火杰西卡【盾牌】）。少了这一步，content 里读 event.result 永远
			//   是 undefined —— 表现就是「技能飘了字、语音也响了，却谁都没弃牌」。
			player.storage.chen_jueying_pick = result && result.control;
		},
		async content(event, trigger, player) {
			const pick = player.storage.chen_jueying_pick;
			delete player.storage.chen_jueying_pick;
			const type = CHEN_TYPES.find(item => CHEN_TYPE_TEXT[item] == pick);
			if (!type) {
				return;
			}
			for (const side of chenDamageSides(trigger)) {
				const cards = side.getCards("hej", card => get.type2(card) == type);
				if (!cards.length) {
					continue;
				}
				player.line(side, "green");
				await side.discard(cards);
				game.log(player, "令", side, "弃置了区域内所有的", CHEN_TYPE_TEXT[type]);
			}
		},
		// ★ 不发动（点取消 / 一个类型都选不出来）→ 记下「下次由牌造成的伤害+1」
		oncancel(trigger, player) {
			chenJueyingMark(player);
		},
	},

	// 【绝影】的后半段：下次由牌造成的伤害+1。
	// 用标记而不是 storage ——「不可叠加」正好就是「标记至多 1 枚」。
	chen_jueying_buff: {
		audio: false,
		charlotte: true,
		mark: true,
		marktext: "绝影",
		intro: { content: "你下次由牌造成的伤害+1（不可叠加）" },
		sourceSkill: "chen_jueying",
		trigger: { source: "damageBegin1" },
		forced: true,
		silent: true,
		popup: false,
		filter(event, player) {
			// 「由牌造成」——技能伤害不带牌，不算数
			return !!event.card && player.countMark("chen_jueying_buff") > 0;
		},
		async content(event, trigger, player) {
			trigger.num += 1;
			player.removeMark("chen_jueying_buff", player.countMark("chen_jueying_buff"));
		},
	},

	// 【赤霄：拔刀】你使用牌指定唯一目标时，可以令目标对你造成一点伤害，
	// 并令此牌结算两次。
	chen_badao: {
		audio: "ext:方舟/skill:2",
		trigger: { player: "useCard" },
		filter(event, player) {
			// ★ 装备牌「结算两次」没有意义，作者要求直接不让它触发
			return !!event.card && get.type(event.card) != "equip" && Array.isArray(event.targets) && event.targets.length == 1;
		},
		async cost(event, trigger, player) {
			const target = trigger.targets[0];
			event.result = await player
				.chooseBool(get.prompt("chen_badao", target))
				.set("prompt2", "令" + get.translation(target) + "对你造成1点伤害，然后此牌结算两次。")
				.set("ai", () => chenBadaoWorth(trigger, player))
				.forResult();
		},
		async content(event, trigger, player) {
			const target = trigger.targets[0];
			// 「令目标对你造成一点伤害」——来源是目标、受伤者是你
			await player.damage(1, target);
			// 「令此牌结算两次」= 把 useCard 的 effectCount 拉成 2。引擎在第一次结算完
			// 目标之后会重新走一遍对目标的结算（content.js 里 effectedCount < effectCount
			// 那一步就是干这个的）。useCard 时机排在 effectCount 初始化**之后**，
			// 所以这里改得动；effectedCount 也在那时候归零了。
			trigger.effectCount = 2;
		},
	},

	// 【形照】任何阶段结束时，若你于此阶段内失去过牌，你从牌堆中获得每种你手牌中
	// 未持有的牌类型各 1 张；若以此法获得至少 2 张牌，你回复 1 点体力。
	chen_xingzhao: {
		audio: "ext:方舟/skill:2",
		group: ["chen_xingzhao_lost"],
		// ★ 作者口径：「所有角色的每个小阶段」。引擎里只有出牌阶段自带 phaseUseEnd，
		//   其他小阶段没有统一的结束时机，所以改用 phase 事件上的两个 timing：
		//     · phaseChange —— 每次进入下一个阶段**之前**触发，于是它报的正是刚结束的那个
		//     · phaseEnd     —— 阶段序列整个走完时触发，补上最后一个阶段
		//   两处都取 phaseList[num - 1]，也就是「刚刚结束的那个阶段」。
		//   开局那次 phaseChange（num = 0）没有上一个阶段，所以 filter 里要求 num >= 1。
		trigger: { global: ["phaseChange", "phaseEnd"] },
		forced: true,
		// ★ 只在**真的从牌堆抽到牌**时才播语音 / 飘字（作者要求）：引擎在
		//   forced 触发技跑 content 之前会自己 logSkill 一次，用 popup: false
		//   把它挡掉，改由 content 在抽牌那一刻手动补。
		popup: false,
		filter(event, player) {
			return event.num >= 1 && player.countMark("chen_xingzhao_lost") > 0;
		},
		async content(event, trigger, player) {
			// 先清账：这次结算的就是「刚才那个阶段」攒下的标记
			player.removeMark("chen_xingzhao_lost", player.countMark("chen_xingzhao_lost"));
			const owned = new Set();
			for (const card of player.getCards("h")) {
				owned.add(get.type2(card));
			}
			const gained = [];
			for (const type of CHEN_TYPES) {
				if (owned.has(type)) {
					continue;
				}
				const card = get.cardPile2(item => get.type2(item) == type);
				if (!card) {
					continue;
				}
				// 从牌堆里取走（get.cardPile2 只查不取，同年的【锻器】）
				card.original = "c";
				ui.cardPile.removeChild(card);
				gained.push(card);
			}
			if (!gained.length) {
				// 一种类型都不缺（或者牌堆里没有）→ 静默收场：不播语音、也不飘字
				return;
			}
			// 到这一步才算「真的触发了形照的效果」——语音与飘字就放在抽牌这一刻
			player.logSkill("chen_xingzhao");
			game.updateRoundNumber();
			game.log(player, "从牌堆中获得了", gained);
			await player.gain(gained, "gain2");
			if (gained.length >= 2) {
				await player.recover(1);
			}
		},
	},

	// 【形照】的记账：陈在这个阶段里失去过牌（使用 / 打出 / 弃置 / 交出 / 被拿走都算）
	chen_xingzhao_lost: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "chen_xingzhao",
		trigger: { player: "loseAfter" },
		filter(event, player) {
			return Array.isArray(event.cards) && event.cards.length > 0;
		},
		async content(event, trigger, player) {
			player.addMark("chen_xingzhao_lost", 1);
		},
	},

	// ══ 藿藿 · 令奉贞凶（魏 / 3体力）══════════════════════════════
	// 描述文件：素材\_待实现\藿藿\描述.txt
	// （素材目录原名「霍霍」，按作者要求统一改成星铁官方译名「藿藿」）
	//
	// 三个技能共用一套「伤害账本」，落地方式都是引擎的 **unreal 伤害**：
	//     player.damage({ num: 1, source: X, unreal: true })
	// 它会写进 damage / sourceDamage 两份历史（所以「造成过 / 受到过伤害」这类
	// **条件判定**认它），并且照样走完整个伤害事件的后半截（所以「造成伤害后 /
	// 受到伤害后」这类**时点技能**也会被它点着）；它唯一不做的事是**扣体力**：
	// 只跳过 damageBegin1~4 与濒死判定，damage / damageEnd / damageAfter /
	// damageSource 全部照常触发 —— 正是作者要的「只是造成过伤害，不实际造成伤害」。
	// 官方【星·周不疑】的【慧夭】（「令其视为对另一名你选择的角色造成过1点伤害」，
	// 用途就是帮队友点着「造成过伤害」类技能）用的是同一套语义。
	// （引擎侧依据：player.js 的 damage() 里 `next.unreal` 会把 _triggered 置 2；
	//   content.js 的 damage 第一句就是 `event.goto(4); return;`，而写历史与
	//   「视为受到了…」那句日志都在主体那一步、排在 `goto(6)` 之前，所以
	//   账照记、血不掉。已有先例：维什戴尔【魂影】。）

	// ── 护命 ─────────────────────────────────────────────────────
	// 描述（作者改稿）：锁定技，当你受到伤害时，伤害来源需弃置任意张牌，
	//       你摸X+1张牌，若X为0，你在此阶段结束时恢复1点体力
	//       （X 为其弃置的牌数且至多为 2）。
	// ★ 锁定技 = 藿藿这边没有「发不发动」的余地，所以**没有 cost**：
	//   filter 一过就直接结算（同【尾巴】）。原先用 cost 是错的 —— cost 被取消
	//   时整个技能都不发动，而按作者口径「X 可以取 0」，来源选择不弃牌时藿藿
	//   **照样要摸 1 张**，不能连技能一起吞掉。
	// ★ 弃几张由**伤害来源自己**定，且**不设上限**（作者口径「任意张」，选择框
	//   给的是 0 ~ 他区域内的牌数）；但 X 至多为 2 —— 多弃的牌不增加收益。
	//   X = 0（一张不弃）时藿藿摸 1 张，**并且在此阶段结束时回复 1 点体力**
	//   ——「至少摸一张 + 补一口血」正是锁定技的意义所在；代价是
	//   「若X为0」这一支得拖到阶段结束才结算（交给下面的 hh_huming_end）。
	// ★ 施动者是**伤害来源**，不是藿藿：chooseToDiscard 挂在 source 身上。
	// ★ 不排 unreal：藿藿「视为受到伤害」时也要发动（实机口径，见 filter 注释）。
	// ★ 时机取 damageEnd（作者原文写「受到伤害时」）：让这次伤害连濒死结算一起
	//   走完，再谈弃牌与摸牌，弃牌就不会插进伤害流程中间（同陈【绝影】的口径）。
	hh_huming: {
		audio: "ext:方舟/skill:3",
		locked: true,
		forced: true,
		// ★ 这一稿**没有次数限制**（作者把「每回合限两次」挪给了【尾巴】）：
		//   每次受伤都结算，配「弃任意张」就是「来源每一刀都得表态」。
		//   若哪天真要加回限制，触发技的 usable 由 lib.filter.filterTrigger 卡
		//   （index.js 里 `player.getStat("triggerSkill")[skill] >= usable` 就挡住），
		//   它数的正是「当前回合」—— 每个角色的回合开始时 content.js 会给**全场
		//   每个人**各 push 一条新的 stat（`current.stat.push(…)`），而 getStat
		//   取的是最后一条，所以无论那个回合是谁的都算。
		group: ["hh_huming_end"],
		trigger: { player: "damageEnd" },
		filter(event, player) {
			// ① ★ 实机口径：unreal（【尾巴】【凭依】记的那两笔账）**也算受伤** ——
			//    藿藿「视为受到伤害」时【护命】照样发动，所以这里**故意不写**
			//    `!event.unreal`。【护命】自己只让来源弃牌、让藿藿摸牌，**不产生
			//    任何伤害**，所以问不出循环来；代价是每次被凭依者挨打，伤害来源
			//    都会被问一次要不要弃牌 —— 这正是「藿藿把这一下也当成自己挨的」。
			// ② ★ 不再要求来源有牌：X 可以取 0，他一张牌都没有时藿藿照样摸 1 张、
			//    照样在阶段结束时回那 1 点体力。
			//    只要求这一下有个来源可问（没有来源就没有「X」可言）。
			return event.num > 0 && !!event.source;
		},
		async content(event, trigger, player) {
			const source = trigger.source;
			let num = 0;
			// 他一张牌都没有：没什么可问的，X 直接记 0
			if (source.countCards("he") > 0) {
				// ★ X 封顶 2，AI 就只认最不值钱的那两张 —— 免得它一路弃到没牌为止。
				//   （引擎的 chooseToDiscard 的 AI 是「只要还有正分的牌就继续弃」，
				//    打分函数对所有牌都给正分时它会一直弃下去。）
				const cheapest = source
					.getCards("he")
					.slice(0)
					.sort((a, b) => get.value(a, source) - get.value(b, source))
					.slice(0, 2);
				// 弃置张数**不设上限**（作者口径「任意张」）：selectCard 上限给到他
				// 区域内的牌数（手牌 + 装备区，判定区不算），下限给 0 —— 他可以直接
				// 点确定一张不弃，点取消也算不弃。
				const result = await source
					.chooseToDiscard(get.prompt("hh_huming", player), [0, source.countCards("he")], "he")
					.set(
						"prompt2",
						"弃置任意张牌（至多 2 张计入 X），令" +
							get.translation(player) +
							"摸 X+1 张牌；一张都不弃则其摸 1 张，且在此阶段结束时回复 1 点体力"
					)
					// 只有把藿藿当自己人才值得：弃的牌越不值钱越肯弃。态度不够时
					// 每张牌都给负分，AI 就一张都不弃（下限是 0，不必点取消）
					// ★ source == player 也走「肯弃」这一支：【尾巴】的 AI 会让藿藿
					//   自己对自己记一笔账，那笔账会绕回来触发【护命】—— 此时弃的
					//   是藿藿自己的牌、摸回来的是 X+1 张，稳赚（`get.attitude(自己,
					//   自己)` 是 0，不特判就会一张都不弃）
					.set("ai", card => {
						if (source != player && get.attitude(source, player) <= 0) {
							return -1;
						}
						return cheapest.includes(card) ? 6 - get.value(card) : -1;
					})
					.forResult();
				// 取消（bool:false）与「点了确定但一张没选」都算 X = 0
				num = Math.min((result.cards || []).length, 2);
			}
			await player.draw(num + 1);
			// X = 0：这一下的补偿不在摸牌上，而是「此阶段结束时回复 1 点体力」，
			// 交给下面的 hh_huming_end 收尾（同一阶段最多回 1 点，所以只记 bool）
			if (num === 0) {
				player.storage.hh_huming_delay = true;
			}
		},
	},

	// 【护命】的欠账：X = 0 时答应「此阶段结束时回复 1 点体力」。
	// 引擎里**每个**游戏事件跑完内容后都会自动触发 `<事件名>End`
	// （GameEvent.loop 里 `await this.trigger(this.name + "End")`），所以六个小阶段
	// 各有自己的结束时机：phaseZhunbeiEnd / phaseJudgeEnd / phaseDrawEnd /
	// phaseUseEnd / phaseDiscardEnd / phaseJieshuEnd（官方就有整组一起挂的先例：
	// clan.js 的 clanshenjun_viewAs 就是 `global` + 这六个 End + charlotte）。
	// 这里整组挂上，并用 global 把别人的阶段也收进来 —— 阶段是串行的，
	// 伤害之后遇到的**第一个**阶段结束时机，正好就是「此阶段」的结束，
	// 所以不必自己去记当时是哪个阶段。
	// ★ 边角：阶段被**跳过**时（GameEvent.checkSkipped 直接 return，不触发 `<名>End`）
	//   会顺延到下一个真正结束的阶段 —— 但被跳过的阶段里根本挨不到打，
	//   所以只有「伤害发生在回合开始时/阶段缝隙」这种情形才可能差一拍。
	// ★ 同一阶段最多回 1 点（作者口径）：欠账只是个 bool，不是计数。
	hh_huming_end: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "hh_huming",
		trigger: {
			global: ["phaseZhunbeiEnd", "phaseJudgeEnd", "phaseDrawEnd", "phaseUseEnd", "phaseDiscardEnd", "phaseJieshuEnd"],
		},
		filter(event, player) {
			return !!player.storage.hh_huming_delay;
		},
		async content(event, trigger, player) {
			delete player.storage.hh_huming_delay;
			await player.recover(1);
		},
	},

	// ── 尾巴 ─────────────────────────────────────────────────────
	// 描述（作者改稿）：锁定技，每回合限两次，你非因本技能受到伤害时，
	//       你可以令一名角色视为对一名角色造成过1点伤害。
	// ★ 「你可以」照旧**不问**（作者本题明确选了「保持锁定技强制发动，不弹确认」）
	//   —— 于是仍是 locked + forced，条件满足就直接结算，玩家没有选择权。
	//   描述里的那三个字只是作者的原文，口径以本题的答复为准。
	// ★ 每回合限两次用引擎原生的 `usable: 2`（见文件里其它 `usable` 的用法）：
	//   由 lib.filter.filterTrigger 卡 `getStat("triggerSkill")[skill] >= 2`，
	//   而 getStat 数是「当前回合」（全场每个角色回合开始时都会 push 一条新的
	//   stat），所以无论挨打发生在谁的回合里，都是真·每回合两次。
	// ★ 「非因本技能受到伤害」= **只排掉自己记的那一笔账**：
	//   记账时在 damage 的参数上打一个 hh_weiba_account 标记
	//   （player.js 的 damage() 对单对象参数走 `Object.assign(next, params)`，
	//    自定义键会原样落到 damage 事件上），filter 见到它就跳过。
	// ★★ 这里**不能**简单地排掉所有 unreal —— 作者口径是「视为受伤也算受伤」，
	//   藿藿被【凭依】记账时【尾巴】照样该发动；真正要挡住的是本技能自己记的那笔，
	//   否则会无限地自己咬自己（unreal 一样会走 damageEnd）。
	// ★ 实机口径：两次选择可以是**同一个人**（「令其视为对自己造成过1点伤害」）。
	hh_weiba: {
		audio: "ext:方舟/skill:3",
		locked: true,
		forced: true,
		usable: 2,
		trigger: { player: "damageEnd" },
		filter(event, player) {
			// ★★ 只排除「自己记的那一笔」，不排除所有 unreal（见上方注释）
			if (event.hh_weiba_account || event.num <= 0) {
				return false;
			}
			// ★ 作者实机口径：两次选择允许落在**同一个人**身上（令某人「视为对自己
			//   造成过1点伤害」也是合法的），所以人数下限从「两个活人」放宽到
			//   「还有一个活人」—— 残局只剩自己和对手时也照样点得着
			return game.players.some(current => current.isAlive());
		},
		async content(event, trigger, player) {
			// ① 先挑「造成过伤害」的那一位：★ AI 优先选**藿藿自己**
			//    —— 自己给自己记一笔账，就不去平白给别人添「造成过伤害」的记录；
			//    自己排在最前，其余仍按态度（对自己人是正的、对敌人是负的）
			const first = await player
				.chooseTarget("尾巴：令一名角色", (card, player2, target) => target.isAlive())
				.set("prompt2", "其视为对一名角色造成过1点伤害（可与自己相同，不实际造成伤害）")
				.set("ai", target => (target == player ? 100 : get.attitude(player, target)))
				.forResult();
			if (!first.bool) {
				return;
			}
			const source = first.targets[0];
			// ② 再挑「受到过伤害」的那一位：★ AI 也优先选**藿藿自己**（不排除藿藿
			//    自己，也**不排除**第一位 —— 描述里写的就是「一名角色」，作者要求
			//    两次可以选同一个人）。两次连起来就是「藿藿视为对自己造成过1点伤害」。
			const second = await player
				.chooseTarget("尾巴：令一名角色受到伤害", (card, player2, target) => target.isAlive())
				.set("prompt2", "其视为受到了" + get.translation(source) + "造成的1点伤害（可与上一位相同，不实际造成伤害）")
				.set("ai", target => (target == player ? 100 : -get.attitude(player, target)))
				.forResult();
			if (!second.bool) {
				return;
			}
			const victim = second.targets[0];
			player.line(source, "green");
			player.line(victim, "green");
			// 两次选到同一个人时，日志别写成「令藿藿视为对藿藿造成过1点伤害」
			if (source == victim) {
				game.log(player, "令", source, "视为对自己造成过1点伤害");
			} else {
				game.log(player, "令", source, "视为对", victim, "造成过1点伤害");
			}
			// 打上专属标记：这一笔账不会再反过来点着【尾巴】自己
			await victim.damage({ num: 1, source, unreal: true, hh_weiba_account: true });
		},
	},

	// ── 凭依 ─────────────────────────────────────────────────────
	// 描述：游戏开始时，你选择一名其他角色，本局游戏其受到伤害后，
	//       伤害来源视为对你造成过1点伤害。
	// 拆成两块：hh_pingyi 负责开局选人，hh_pingyi_body 挂在全局伤害上盯人。
	// ★ 被凭依者记的是 **playerid** 而不是玩家对象 —— storage 要能序列化，
	//   联机下存对象会出问题（同黍的「禾」、安洁莉娜的重力）。
	hh_pingyi: {
		audio: "ext:方舟/skill:1",
		forced: true,
		group: ["hh_pingyi_body"],
		trigger: { global: "gameStart" },
		async content(event, trigger, player) {
			const result = await player
				.chooseTarget("凭依：选择一名其他角色", lib.filter.notMe)
				.set("prompt2", "本局游戏其受到伤害后，伤害来源视为对你造成过1点伤害")
				// 被凭依者挨打只是替藿藿「记账」，本身不产生损益，
				// 所以 AI 就挑态度最差的那个
				.set("ai", target => -get.attitude(player, target))
				.forResult();
			if (!result.bool) {
				return;
			}
			const target = result.targets[0];
			player.storage.hh_pingyi_id = target.playerid;
			// ★ 给被凭依者挂一个**看得见**的「凭依」标记（同遥的「浮泡」）：
			//   逻辑真相仍是上面的 storage，标记只负责让全场一眼看出谁被凭依了。
			//   addMark 内部会自己调 markSkill，所以不需要 addSkill 给他。
			target.addMark("hh_pingyi_mark", 1, false);
			player.line(target, "green");
			game.log(player, "凭依了", target);
		},
	},

	// 被凭依者受伤 → 藿藿「视为受到」来自同一个伤害来源的 1 点伤害（只记账）。
	hh_pingyi_body: {
		audio: false,
		charlotte: true,
		forced: true,
		silent: true,
		popup: false,
		sourceSkill: "hh_pingyi",
		trigger: { global: "damageEnd" },
		filter(event, player) {
			// 同理：unreal 不再往下一层传，免得账互相滚起来
			if (event.unreal || event.num <= 0 || !event.source) {
				return false;
			}
			const id = player.storage.hh_pingyi_id;
			if (id == null) {
				return false;
			}
			const bond = game.players.concat(game.dead || []).find(current => current.playerid == id);
			return !!bond && event.player == bond;
		},
		async content(event, trigger, player) {
			player.line(trigger.source, "green");
			await player.damage({ num: 1, source: trigger.source, unreal: true });
		},
	},

	// 「凭依」标记：纯 intro 容器，挂在**被凭依者**身上（同遥的「浮泡」）。
	// addMark / removeMark 内部会自己调 markSkill / unmarkSkill，而 markSkill
	// 只要求 lib.skill[标记名].intro 存在就能把标记渲染出来，所以这里既不用
	// addSkill 给谁、也不是一个真正可发动的技能。
	// 逻辑真相仍在 hh_pingyi 的 storage.hh_pingyi_id，标记只负责「让人一眼看见
	// 谁被凭依了」；被凭依者阵亡时标记会被静默清掉，不影响判定（死人不会再受伤）。
	hh_pingyi_mark: {
		audio: false,
		charlotte: true,
		mark: true,
		marktext: "凭依",
		intro: {
			name: "凭依",
			content: "藿藿的【凭依】标记：拥有此标记的角色受到伤害后，伤害来源视为对藿藿造成过1点伤害（不实际造成伤害）。",
		},
	},
};

export default skills;
