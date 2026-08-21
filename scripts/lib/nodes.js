// Loads the Code nodes out of the workflow JSON and runs them against a
// minimal mock of the n8n Code-node context, so the tests exercise exactly
// the source that ships in the workflow.
const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', '..', 'workflows', 'mailchimp_tags_update.json');
const workflow = JSON.parse(fs.readFileSync(WF, 'utf8'));
const codeOf = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node not found: ${name}`);
  return n.parameters.jsCode;
};

// items: array of plain objects -> n8n items
const wrap = (arr) => arr.map((json) => ({ json }));

// nodeData: { 'Node Name': { branches: [items0, items1] } }
function makeProxy(nodeData) {
  return (name) => {
    const branches = (nodeData[name] || {}).branches || [];
    const pick = (b = 0) => branches[b] || [];
    const declared = workflow.nodes.find((x) => x.name === name);
    return {
      params: (nodeData[name] || {}).params
        || (declared ? declared.parameters : undefined)
        || {},
      all: (b = 0) => pick(b),
      first: (b = 0) => pick(b)[0],
      last: (b = 0) => pick(b)[pick(b).length - 1],
    };
  };
}

function run(nodeName, inputItems, nodeData = {}) {
  const items = wrap(inputItems);
  const $input = {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
  };
  const fn = new Function('$input', '$', codeOf(nodeName));
  return fn($input, makeProxy(nodeData)).map((i) => i.json);
}

// same, but keeps the n8n item wrapper — for nodes whose output is fed onward
function runRaw(nodeName, inputItems, nodeData = {}) {
  return run(nodeName, inputItems, nodeData).map((json) => ({ json }));
}

module.exports = { workflow, run, runRaw, wrap };
