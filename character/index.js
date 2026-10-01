import { game } from "noname";
import characters from "./character.js";
import skills from "./skill.js";
import translates from "./translate.js";
import characterIntros from "./intro.js";
import characterTitles from "./title.js";
import { characterSort, characterSortTranslate } from "./sort.js";
// 十张「神宝」衍生装备牌（含它们的装备技能），见 card.js 顶部的说明
import { cards as shenbaoCards, shenbaoSkills } from "./card.js";

// game.import("character", ...) 就是把下面这些数据合并进 lib.characterPack / lib.skill / lib.translate
// name 是角色包的 id：决定 lib.characterPack 的键、选将界面分组、以及 config 里 characters 数组的成员名
game.import("character", function () {
	return {
		name: "arknights",
		// connect: true = 本角色包允许在联机模式下使用。
		// ★这是联机最关键的开关：联机模式下 loadCharacter 对「没标记 connect 的包」
		//   会把每个技能替换成只保留 nopop / derivation 的空壳
		//   （见 init/loading.js 第 163 行），技能点开会毫无反应。
		//   加了这个字段后本包还会自动进入 lib.connectCharacterPack，
		//   也就是联机建房时的「武将包」可选列表。
		connect: true,
		// 武将定义表
		character: { ...characters },
		// 选将界面的排序分组，键是本文件的包名 arknights
		characterSort: { arknights: characterSort },
		// 武将简介（选将界面里长按/悬停查看）
		characterIntro: { ...characterIntros },
		// 武将称号
		characterTitle: { ...characterTitles },
		// 卡牌表：辉夜的十张「神宝」。
		// loadCharacter 对 character 包里的 card 字段是照单全收的
		// （见 init/loading.js 的 `if (key === "card")` 那一段），
		// 所以角色包自带的衍生卡直接写在这儿就行，不用另外注册一个卡牌包。
		card: { ...shenbaoCards },
		// 技能定义表（武将技能 + 神宝的装备技能）
		skill: { ...skills, ...shenbaoSkills },
		// 翻译表：武将名、技能名、技能描述、卡牌名、分组名
		translate: { ...translates, ...characterSortTranslate },
	};
});
