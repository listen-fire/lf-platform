// The corpus files a version's lists rule out whole (`wholeFile: true`, no
// `test`): files that cannot even load, because they mock modules the current
// code has replaced. Jest never opens them, so the run lists no tests for them.
const fs = require('fs');
const path = require('path');

/** A corpus's ruled-out entries: its triage (changes no author can observe)
 *  and, where a release retired behaviour by a ruling, its `retired.cjs`
 *  (changes an author can see, each naming its ruling). One entry shape. */
const ruledOutEntries = (corpusRoot) => {
  const { triage } = require(path.join(corpusRoot, 'triage.cjs'));
  const retiredPath = path.join(corpusRoot, 'retired.cjs');
  const retired = fs.existsSync(retiredPath) ? require(retiredPath).retired : [];
  return [...triage, ...retired];
};

const ignoredPaths = (corpusRoot) => {
  return ruledOutEntries(corpusRoot)
    .filter((entry) => entry.wholeFile)
    .map((entry) => path.join(corpusRoot, entry.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
};

module.exports = { ignoredPaths, ruledOutEntries };
