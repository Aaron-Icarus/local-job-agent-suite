function normalizeCompany(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/股份有限公司|有限责任公司|有限公司|集团|公司/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()\（\）【】\[\]·\-_\s]/g, "")
    .replace(/上海|base上海|急招|高薪/g, "")
    .trim();
}

function normalizedDescription(row) {
  return String(row.job_description || row.page_card_text || row.facts?.job_description || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。；、,.!?！？:：()（）【】\[\]<>《》"'“”‘’]/g, "");
}

function shingles(text, size = 4) {
  const normalized = String(text || "");
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  const out = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) out.add(normalized.slice(index, index + size));
  return out;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function descriptionSimilarity(left, right) {
  const a = normalizedDescription(left);
  const b = normalizedDescription(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return jaccard(shingles(a), shingles(b));
}

function locationOf(row) {
  return String(row.district || row.business_area || row.address || row.city || row.facts?.district || row.facts?.city || "");
}

function salaryOf(row) {
  return String(row.salary || row.facts?.salary_text || "");
}

function ingestedAt(entry) {
  const value = entry.ingested_at || entry.first_seen_at || entry.first_seen_date || "";
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Infinity;
}

// 跨渠道同一岗位：公司/标题归一化后一致，并且 JD 高度相似，或地点+薪资一致。
// 只在“新记录”入库时调用；返回更早的那条主记录。
function findEarlierCrossChannelDuplicate(store, row, options = {}) {
  const threshold = Number(options.threshold || 0.8);
  const platform = String(row.platform || "").toLowerCase();
  const company = normalizeCompany(row.company || row.facts?.company);
  const title = normalizeTitle(row.job_title || row.facts?.job_title);
  if (!company || !title) return null;
  const currentKey = options.currentKey || "";
  let best = null;
  for (const [key, entry] of Object.entries((store && store.jobs) || {})) {
    if (!entry || key === currentKey) continue;
    if (String(entry.platform || "").toLowerCase() === platform) continue;
    const baseKey = entry.duplicate_of_key && store.jobs[entry.duplicate_of_key] ? entry.duplicate_of_key : key;
    const baseEntry = store.jobs[baseKey] || entry;
    if (normalizeCompany(baseEntry.company || baseEntry.facts?.company) !== company) continue;
    if (normalizeTitle(baseEntry.job_title || baseEntry.facts?.job_title) !== title) continue;
    const score = descriptionSimilarity(row, baseEntry);
    const sameLocation = locationOf(row) && locationOf(row) === locationOf(baseEntry);
    const sameSalary = salaryOf(row) && salaryOf(row) === salaryOf(baseEntry);
    const duplicate = score >= threshold || (sameLocation && sameSalary && score >= 0.5);
    if (!duplicate) continue;
    // 永远选“入库时间更早”的主记录；新行尚未入库，不能用它和 base 比较先后。
    if (!best || ingestedAt(baseEntry) < ingestedAt(best.entry) ||
        (ingestedAt(baseEntry) === ingestedAt(best.entry) && String(baseEntry.display_id || "") < String(best.entry.display_id || ""))) {
      best = { key: baseKey, entry: baseEntry, score: Number(score.toFixed(3)), sameLocation, sameSalary };
    }
  }
  return best;
}

module.exports = {
  normalizeCompany,
  normalizeTitle,
  normalizedDescription,
  descriptionSimilarity,
  findEarlierCrossChannelDuplicate,
};
