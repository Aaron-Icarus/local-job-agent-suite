const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");
const profileDir = path.join(rootDir, "config", "candidate_profiles");
const currentProfileConfigPath = path.join(profileDir, "current.json");

function loadCurrentCandidateProfile(options = {}) {
  const configPath = options.configPath || currentProfileConfigPath;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const profilePath = path.resolve(path.dirname(configPath), config.profile_file || "");
  if (!config.profile_file || !fs.existsSync(profilePath)) {
    throw new Error(`Current candidate profile file not found: ${profilePath}`);
  }
  return {
    id: config.current_candidate_id || "current_candidate",
    version: config.profile_version || 1,
    path: profilePath,
    markdown: fs.readFileSync(profilePath, "utf8").trim(),
  };
}

module.exports = { loadCurrentCandidateProfile, currentProfileConfigPath };
