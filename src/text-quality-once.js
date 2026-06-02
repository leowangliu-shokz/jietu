import { rebuildTextQuality } from "./text-quality.js";

const records = await rebuildTextQuality({
  latestOnly: !process.argv.includes("--all")
});
const issueCount = records.reduce((sum, record) => sum + Number(record.issueCount || 0), 0);
console.log(`Saved ${records.length} Woodpecker records to data/text-quality.json`);
console.log(`Detected ${issueCount} spelling or grammar issues.`);
