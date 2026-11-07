const PROVINCES = {
  北京市: ["北京市"],
  上海市: ["上海市"],
  天津市: ["天津市"],
  重庆市: ["重庆市"],
  江苏省: ["南京市", "苏州市", "无锡市", "常州市", "南通市", "扬州市", "镇江市", "泰州市", "盐城市", "淮安市", "连云港市", "宿迁市", "徐州市"],
  浙江省: ["杭州市", "宁波市", "温州市", "嘉兴市", "湖州市", "绍兴市", "金华市", "衢州市", "舟山市", "台州市", "丽水市"],
  广东省: ["广州市", "深圳市", "珠海市", "佛山市", "东莞市", "中山市", "惠州市", "汕头市", "江门市", "湛江市", "肇庆市"],
  山东省: ["济南市", "青岛市", "烟台市", "潍坊市", "临沂市", "淄博市", "济宁市", "泰安市", "威海市"],
  四川省: ["成都市", "绵阳市", "德阳市", "宜宾市", "南充市", "泸州市"],
  湖北省: ["武汉市", "宜昌市", "襄阳市", "荆州市", "黄石市"],
  湖南省: ["长沙市", "株洲市", "湘潭市", "衡阳市", "岳阳市"],
  河南省: ["郑州市", "洛阳市", "开封市", "南阳市", "新乡市"],
  河北省: ["石家庄市", "唐山市", "保定市", "廊坊市", "邯郸市"],
  福建省: ["福州市", "厦门市", "泉州市", "漳州市", "莆田市"],
  安徽省: ["合肥市", "芜湖市", "蚌埠市", "安庆市", "马鞍山市"],
  江西省: ["南昌市", "赣州市", "九江市", "上饶市"],
  陕西省: ["西安市", "咸阳市", "宝鸡市", "渭南市"],
  辽宁省: ["沈阳市", "大连市", "鞍山市", "抚顺市"],
  吉林省: ["长春市", "吉林市", "四平市"],
  黑龙江省: ["哈尔滨市", "大庆市", "齐齐哈尔市"],
  山西省: ["太原市", "大同市", "运城市"],
  云南省: ["昆明市", "大理市", "曲靖市"],
  贵州省: ["贵阳市", "遵义市"],
  广西壮族自治区: ["南宁市", "桂林市", "柳州市"],
  内蒙古自治区: ["呼和浩特市", "包头市", "鄂尔多斯市"],
  新疆维吾尔自治区: ["乌鲁木齐市", "昌吉市"],
  甘肃省: ["兰州市", "天水市"],
  海南省: ["海口市", "三亚市"],
  宁夏回族自治区: ["银川市"],
  青海省: ["西宁市"],
  西藏自治区: ["拉萨市"],
};
const DISTRICTS = {
  苏州市: ["姑苏区", "虎丘区", "吴中区", "相城区", "吴江区", "工业园区", "昆山市", "常熟市", "张家港市", "太仓市"],
  南京市: ["玄武区", "秦淮区", "建邺区", "鼓楼区", "浦口区", "栖霞区", "雨花台区", "江宁区"],
  上海市: ["黄浦区", "徐汇区", "长宁区", "静安区", "普陀区", "虹口区", "杨浦区", "浦东新区", "闵行区", "宝山区", "嘉定区", "松江区", "青浦区", "奉贤区"],
  北京市: ["东城区", "西城区", "朝阳区", "海淀区", "丰台区", "石景山区", "通州区", "昌平区", "大兴区"],
  杭州市: ["上城区", "拱墅区", "西湖区", "滨江区", "萧山区", "余杭区", "临平区", "钱塘区"],
  深圳市: ["福田区", "罗湖区", "南山区", "宝安区", "龙岗区", "龙华区", "坪山区", "光明区"],
  广州市: ["越秀区", "海珠区", "荔湾区", "天河区", "白云区", "黄埔区", "番禺区", "花都区"],
};

function stripSuffix(name) {
  return String(name || "").replace(/(省|市|区|县|自治区|自治州|地区)$/g, "");
}

function findProvince(token) {
  const raw = String(token || "").trim();
  const direct = Object.keys(PROVINCES).find((province) => province === raw || stripSuffix(province) === stripSuffix(raw));
  if (direct) return direct;
  for (const [province, cities] of Object.entries(PROVINCES)) {
    if (cities.some((city) => city === raw || stripSuffix(city) === stripSuffix(raw))) return province;
  }
  return "";
}

function findCity(token) {
  const raw = String(token || "").trim();
  for (const [province, cities] of Object.entries(PROVINCES)) {
    const city = cities.find((item) => item === raw || stripSuffix(item) === stripSuffix(raw));
    if (city) return { province, city };
  }
  return null;
}

function findDistrict(token) {
  const raw = String(token || "").trim();
  for (const [city, districts] of Object.entries(DISTRICTS)) {
    const district = districts.find((item) => item === raw || stripSuffix(item) === stripSuffix(raw));
    if (district) {
      const found = findCity(city);
      return { province: found?.province || "", city, district };
    }
  }
  return null;
}

function normalizeOneLocation(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const provincePrefix = Object.keys(PROVINCES).find((province) => raw.startsWith(province));
  if (provincePrefix && raw !== provincePrefix) {
    const remainder = raw.slice(provincePrefix.length).trim();
    const district = findDistrict(remainder);
    if (district) return { ...district, province: district.province || provincePrefix, label: `${district.province || provincePrefix}-${district.city}-${district.district}` };
    const city = findCity(remainder);
    if (city) return { ...city, district: "全部", label: `${provincePrefix}-${city.city}-全部` };
  }
  const district = findDistrict(raw);
  if (district) return { ...district, label: `${district.province}-${district.city}-${district.district}` };
  const city = findCity(raw);
  if (city) return { ...city, district: "全部", label: `${city.province}-${city.city}-全部` };
  const province = findProvince(raw);
  if (province && PROVINCES[province]) return { province, city: "全部", district: "全部", label: `${province}-全部-全部` };
  return { province: raw, city: "全部", district: "全部", label: `${raw}-全部-全部` };
}

function normalizeCities(value) {
  const tokens = Array.isArray(value)
    ? value
    : String(value || "").split(/[、,，/;；]/).map((item) => item.trim()).filter(Boolean);
  const list = tokens.map(normalizeOneLocation).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    unique.push(item);
  }
  return {
    cities: unique,
    display: unique.map((item) => item.label).join("、"),
  };
}

function normalizeSalary(input = {}) {
  let min = Number(input.salary_min ?? input.salaryMin);
  let max = Number(input.salary_max ?? input.salaryMax);
  const hasExplicit = input.salary_min != null || input.salary_max != null || input.salaryMin != null || input.salaryMax != null;
  if (hasExplicit && max === 0) throw new Error("期望薪资上限不能为 0");
  const legacy = String(input.target_salary || input.targetSalary || "").match(/(\d+)\s*[-~至]\s*(\d+)/);
  if ((!Number.isFinite(min) || !Number.isFinite(max)) && legacy) {
    min = Number(legacy[1]);
    max = Number(legacy[2]);
  }
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max <= 0) {
    return { salaryMin: null, salaryMax: null, display: String(input.target_salary || "") };
  }
  if (max < min) throw new Error("期望薪资上限不能小于下限");
  return { salaryMin: min, salaryMax: max, display: `${min}-${max}K` };
}

module.exports = { PROVINCES, DISTRICTS, normalizeCities, normalizeSalary, normalizeOneLocation };
