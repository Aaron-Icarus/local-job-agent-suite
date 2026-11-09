const crypto = require("crypto");

const RESUME_SCHEMA_VERSION = "1.0";
const KNOWN_SECTIONS = [
  "目标岗位", "求职意向", "期望岗位", "工作经历", "项目经历", "工作经验", "职业经历",
  "教育经历", "教育背景", "学历", "技能", "专业技能", "技术栈", "个人简介", "自我评价",
  "概述", "摘要", "求职偏好", "期望城市", "期望薪资",
];

function sectionMap(markdown) {
  const sections = {};
  let current = "未分类";
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      current = heading[1].trim();
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!sections[current]) sections[current] = [];
    if (line) sections[current].push(line);
  }
  return sections;
}

function valuesFor(sections, names) {
  for (const name of names) {
    const key = Object.keys(sections).find((item) => item.includes(name));
    if (key && sections[key].length) return sections[key].join(" ");
  }
  return "";
}

function parseList(value) {
  return String(value || "")
    .split(/[,，、;；/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanLines(markdown) {
  return String(markdown || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").trim())
    .filter((line) => line && !/^\d{5,}$/.test(line));
}

function findLabeled(lines, labels) {
  for (const label of labels) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(new RegExp(`^${label}\\s*[：:]\\s*(.+)$`));
      if (match) return match[1].trim();
      if (line === label && lines[index + 1]) return lines[index + 1].trim();
    }
  }
  return "";
}

function inferName(lines, markdown) {
  const title = String(markdown || "").match(/^#\s+(.+)$/m);
  if (title) {
    const value = title[1].replace(/简历|个人简历/gi, "").trim();
    if (value) return value;
  }
  const direct = String(markdown || "").match(/姓\s*名\s*[：:]\s*([^\n]{2,30})/);
  if (direct) return direct[1].replace(/[（(].*?[）)]/g, "").trim().slice(0, 30);
  const labeled = findLabeled(lines, ["姓名", "名字"]);
  if (labeled) return labeled.replace(/[（(].*?[）)]/g, "").trim().slice(0, 30);
  for (const line of lines.slice(0, 8)) {
    if (/^(20\d{2}|19\d{2})[.\-/年]/.test(line)) continue;
    if (/[：:]/.test(line)) continue;
    if (/^[\u4e00-\u9fa5A-Za-z·.\s]{2,20}$/.test(line)) return line;
  }
  return "";
}

function collectSection(lines, names) {
  const output = [];
  let active = false;
  for (const line of lines) {
    const isHeading = KNOWN_SECTIONS.some((name) => line === name || line.startsWith(`${name}：`) || line.startsWith(`${name}:`));
    if (isHeading) {
      const matched = names.some((name) => line === name || line.startsWith(`${name}：`) || line.startsWith(`${name}:`));
      active = matched;
      const inline = line.match(/^[^：:]+[：:]\s*(.+)$/);
      if (active && inline) output.push(inline[1].trim());
      continue;
    }
    if (active) output.push(line);
  }
  return output.join("\n").trim();
}

function inferExperience(lines) {
  const inSection = collectSection(lines, ["工作经历", "项目经历", "工作经验", "职业经历"]);
  if (inSection) return inSection.slice(0, 2000);
  const start = lines.findIndex((line) => /^(19|20)\d{2}[.\-/年]/.test(line));
  if (start >= 0) {
    const educationIndex = lines.findIndex((line, index) => index > start && /教育|学历|毕业院校/.test(line));
    const end = educationIndex > start ? educationIndex : lines.length;
    return lines.slice(start, end).join("\n").slice(0, 2000);
  }
  return "";
}

function inferEducation(lines, markdown) {
  const inSection = collectSection(lines, ["教育经历", "教育背景"]);
  if (inSection) return inSection.slice(0, 500);
  const values = lines.filter((line) => /学历|本科|硕士|博士|毕业院校|就读时间/.test(line));
  const raw = String(markdown || "");
  const degree = raw.match(/学\s*历\s*[：:]\s*([^\n]+)/);
  const school = raw.match(/毕业院校\s*[：:]\s*([^\n]+)/);
  const parts = [degree?.[1], school?.[1], ...values.filter((line) => /就读时间/.test(line))].filter(Boolean);
  return [...new Set(parts)].join("；").slice(0, 500);
}

function inferSummary(lines) {
  const inSection = collectSection(lines, ["个人简介", "自我评价", "概述", "摘要"]);
  if (inSection) return inSection.slice(0, 500);
  for (const line of lines) {
    if (line.length >= 30 && !/^(19|20)\d{2}|学历|毕业院校|电话|邮箱|姓名/.test(line)) return line.slice(0, 500);
  }
  return "";
}

function parseResumeMarkdown(markdown) {
  const raw = String(markdown || "").trim();
  if (!raw) throw new Error("简历内容为空");
  const sections = sectionMap(raw);
  const lines = cleanLines(raw);
  const name = inferName(lines, raw);
  const target = valuesFor(sections, ["目标岗位", "求职意向", "期望岗位"]) || findLabeled(lines, ["目标岗位", "求职意向", "期望岗位"]);
  const skills = valuesFor(sections, ["技能", "专业能力", "技术栈"]) || findLabeled(lines, ["技能", "专业技能", "技术栈"]);
  const experience = inferExperience(lines) || valuesFor(sections, ["工作经历", "项目经历", "经验"]);
  const education = inferEducation(lines, raw) || valuesFor(sections, ["教育", "学历"]);
  const summary = inferSummary(lines) || valuesFor(sections, ["个人简介", "自我评价", "概述", "摘要"]);
  return {
    schema_version: RESUME_SCHEMA_VERSION,
    name,
    target_roles: parseList(target),
    skills: parseList(skills),
    experience_summary: experience.slice(0, 2000),
    education,
    summary,
    sections: Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.join("\n")])),
    raw_md: raw,
    content_hash: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

function resumeToProfileMarkdown(parsed) {
  const lines = [
    `# ${parsed.name || "候选人"} 画像`,
    "",
    parsed.summary ? `## 概述\n${parsed.summary}` : "",
    parsed.target_roles.length ? `## 目标岗位\n${parsed.target_roles.join("、")}` : "",
    parsed.skills.length ? `## 技能\n${parsed.skills.join("、")}` : "",
    parsed.experience_summary ? `## 经历摘要\n${parsed.experience_summary}` : "",
    parsed.education ? `## 教育\n${parsed.education}` : "",
    "",
    "> 由 MD 简历本地解析生成；AI 深读可在角色确认前补充。",
  ];
  return lines.filter(Boolean).join("\n");
}

module.exports = { RESUME_SCHEMA_VERSION, parseResumeMarkdown, resumeToProfileMarkdown, sectionMap };
