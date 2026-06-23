const GROUPS = {
  brown: { name: "旧城区", color: "#8b5a3c" },
  lightBlue: { name: "滨水区", color: "#59b6d1" },
  pink: { name: "文艺区", color: "#c95091" },
  orange: { name: "商业区", color: "#e7842c" },
  red: { name: "中心区", color: "#d94242" },
  yellow: { name: "阳光区", color: "#e0b923" },
  green: { name: "生态区", color: "#2d9665" },
  darkBlue: { name: "天际区", color: "#2858a7" },
};

function property(index, name, group, price, rents, buildCost) {
  return { index, type: "property", name, group, price, rents, buildCost };
}

function railroad(index, name) {
  return { index, type: "railroad", name, price: 200 };
}

function utility(index, name) {
  return { index, type: "utility", name, price: 150 };
}

const BOARD = [
  { index: 0, type: "go", name: "起点" },
  property(1, "海棠路", "brown", 60, [2, 10, 30, 90, 160, 250], 50),
  { index: 2, type: "chest", name: "公益基金" },
  property(3, "枫桥街", "brown", 60, [4, 20, 60, 180, 320, 450], 50),
  { index: 4, type: "tax", name: "所得税", amount: 200 },
  railroad(5, "北站铁路"),
  property(6, "青石街", "lightBlue", 100, [6, 30, 90, 270, 400, 550], 50),
  { index: 7, type: "chance", name: "机会" },
  property(8, "湖滨路", "lightBlue", 100, [6, 30, 90, 270, 400, 550], 50),
  property(9, "明珠巷", "lightBlue", 120, [8, 40, 100, 300, 450, 600], 50),
  { index: 10, type: "jail", name: "留置所 / 探访" },
  property(11, "花园大道", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
  utility(12, "电力公司"),
  property(13, "剧院街", "pink", 140, [10, 50, 150, 450, 625, 750], 100),
  property(14, "紫藤路", "pink", 160, [12, 60, 180, 500, 700, 900], 100),
  railroad(15, "西站铁路"),
  property(16, "松林路", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
  { index: 17, type: "chest", name: "公益基金" },
  property(18, "港湾街", "orange", 180, [14, 70, 200, 550, 750, 950], 100),
  property(19, "中央路", "orange", 200, [16, 80, 220, 600, 800, 1000], 100),
  { index: 20, type: "parking", name: "城市公园" },
  property(21, "金叶路", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
  { index: 22, type: "chance", name: "机会" },
  property(23, "博物馆路", "red", 220, [18, 90, 250, 700, 875, 1050], 150),
  property(24, "星河大道", "red", 240, [20, 100, 300, 750, 925, 1100], 150),
  railroad(25, "南站铁路"),
  property(26, "海风路", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
  property(27, "珊瑚街", "yellow", 260, [22, 110, 330, 800, 975, 1150], 150),
  utility(28, "自来水厂"),
  property(29, "日光大道", "yellow", 280, [24, 120, 360, 850, 1025, 1200], 150),
  { index: 30, type: "goToJail", name: "前往留置所" },
  property(31, "翡翠路", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
  property(32, "森林大道", "green", 300, [26, 130, 390, 900, 1100, 1275], 200),
  { index: 33, type: "chest", name: "公益基金" },
  property(34, "世纪大道", "green", 320, [28, 150, 450, 1000, 1200, 1400], 200),
  railroad(35, "东站铁路"),
  { index: 36, type: "chance", name: "机会" },
  property(37, "天际路", "darkBlue", 350, [35, 175, 500, 1100, 1300, 1500], 200),
  { index: 38, type: "tax", name: "高档消费税", amount: 100 },
  property(39, "皇冠大道", "darkBlue", 400, [50, 200, 600, 1400, 1700, 2000], 200),
];

const OWNABLE_TYPES = new Set(["property", "railroad", "utility"]);

function groupSpaces(group) {
  return BOARD.filter((space) => space.group === group);
}

module.exports = { BOARD, GROUPS, OWNABLE_TYPES, groupSpaces };
