const crypto = require("crypto");

const RESUME_SCHEMA_VERSION = "1.0";

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

function parseResumeMarkdown(markdown) {
  const raw = String(markdown || "").trim();
  if (!raw) throw new Error("简历内容为空");
  const sections = sectionMap(raw);
  const title = raw.match(/^#\s+(.+)$/m);
  const name = title ? title[1].replace(/简历|个人简历/gi, "").trim() : "";
  const target = valuesFor(sections, ["目标岗位", "求职意向", "期望岗位"]);
  const skills = valuesFor(sections, ["技能", "专业能力", "技术栈"]);
  const experience = valuesFor(sections, ["工作经历", "项目经历", "经验"]);
  const education = valuesFor(sections, ["教育", "学历"]);
  const summary = valuesFor(sections, ["个人简介", "自我评价", "概述", "摘要"]);
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
