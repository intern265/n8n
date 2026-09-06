// Loads the Code nodes out of a workflow JSON and runs them against a
// minimal mock of the n8n Code-node context, so the tests exercise exactly
// the source that ships in the workflow.
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', 'workflows');

// items: array of plain objects -> n8n items
const wrap = (arr) => arr.map((json) => ({ json }));

// nodeData: { 'Node Name': { branches: [items0, items1] } }
function makeProxy(workflow, nodeData) {
  return (name) => {
    const declared = workflow.nodes.find((x) => x.name === name);
    const entry = nodeData[name] || {};
    const branches = entry.branches || [];
    const pick = (b = 0) => branches[b] || [];
    return {
      params: entry.params || (declared ? declared.parameters : undefined) || {},
      all: (b = 0) => pick(b),
      first: (b = 0) => pick(b)[0],
      last: (b = 0) => pick(b)[pick(b).length - 1],
    };
  };
}

// Every workflow file gets its own loader; the returned helpers are bound to it.
function load(fileName) {
  const workflow = JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, fileName), 'utf8'));

  const codeOf = (name) => {
    const n = workflow.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`node not found: ${name}`);
    return n.parameters.jsCode;
  };

  function run(nodeName, inputItems, nodeData = {}) {
    const items = wrap(inputItems);
    const $input = {
      all: () => items,
      first: () => items[0],
      last: () => items[items.length - 1],
    };
    const fn = new Function('$input', '$', codeOf(nodeName));
    return fn($input, makeProxy(workflow, nodeData)).map((i) => i.json);
  }

  // same, but keeps the n8n item wrapper — for nodes whose output is fed onward
  function runRaw(nodeName, inputItems, nodeData = {}) {
    return run(nodeName, inputItems, nodeData).map((json) => ({ json }));
  }

  return { workflow, codeOf, run, runRaw, wrap };
}

// Back-compat: the Mailchimp tests import { workflow, run, runRaw } directly.
const mailchimp = load('mailchimp_tags_update.json');

module.exports = {
  load,
  wrap,
  workflow: mailchimp.workflow,
  run: mailchimp.run,
  runRaw: mailchimp.runRaw,
};
