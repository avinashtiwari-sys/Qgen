const MAX_DEPTH = 25;
const MAX_NODE_VISITS = 2; // allows retry loops without infinite recursion

/**
 * Enumerates all root-to-END paths in a CFG.
 * Returns array of path objects, each carrying the sequence of nodes and active conditions.
 */
function enumeratePaths(cfg) {
  const nodeMap = new Map(cfg.nodes.map(n => [n.node_id, n]));
  const edgesByFrom = new Map();

  for (const edge of cfg.edges) {
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    edgesByFrom.get(edge.from).push(edge);
  }

  const paths = [];
  dfs('START', [], [], {}, nodeMap, edgesByFrom, paths);
  return paths;
}

function dfs(nodeId, currentNodes, currentConditions, visitCounts, nodeMap, edgesByFrom, paths) {
  const node = nodeMap.get(nodeId);
  if (!node) return;

  if (node.type === 'END') {
    paths.push(buildPath(currentNodes.concat(node), currentConditions, node.outcome));
    return;
  }

  // Cycle budget
  const visits = visitCounts[nodeId] || 0;
  if (visits >= MAX_NODE_VISITS) return;

  if (currentNodes.length >= MAX_DEPTH) {
    paths.push(buildPath(
      currentNodes.concat({ node_id: `TRUNCATED_AT_${nodeId}`, type: 'TRUNCATED' }),
      currentConditions,
      'truncated'
    ));
    return;
  }

  const updatedCounts = { ...visitCounts, [nodeId]: visits + 1 };
  const outgoingEdges = edgesByFrom.get(nodeId) || [];

  for (const edge of outgoingEdges) {
    const updatedConditions = edge.condition
      ? currentConditions.concat({ condition: edge.condition, outcome: edge.outcome, at_node: nodeId })
      : currentConditions;

    dfs(edge.to, currentNodes.concat(node), updatedConditions, updatedCounts, nodeMap, edgesByFrom, paths);
  }
}

function buildPath(nodes, conditions, terminalOutcome) {
  // Collect data refs and business rule refs from all nodes in path
  const dataRefs = [...new Set(
    nodes.filter(n => n.test_data_ref).map(n => n.test_data_ref)
  )];
  const businessRuleRefs = [...new Set(
    nodes.filter(n => n.business_rule_ref).map(n => n.business_rule_ref)
  )];

  // Derive a scenario label from the active conditions
  const conditionSummary = conditions.length > 0
    ? conditions.map(c => c.condition).join(' + ')
    : 'No branch conditions (linear path)';

  // Confidence of the whole path = minimum confidence of any node
  const confidencePriority = { high: 3, medium: 2, low: 1 };
  const minConfidence = nodes.reduce((min, n) => {
    const c = confidencePriority[n.confidence] || 3;
    return c < confidencePriority[min] ? n.confidence : min;
  }, 'high');

  return {
    path_id: null,          // assigned by enumeratePaths caller with index
    nodes: nodes.map(n => n.node_id),
    node_details: nodes,
    active_conditions: conditions,
    condition_summary: conditionSummary,
    terminal_outcome: terminalOutcome || 'unknown',
    data_refs: dataRefs,
    business_rule_refs: businessRuleRefs,
    confidence: minConfidence,
  };
}

/**
 * Entry point: enumerate paths across all CFGs and assign path IDs.
 */
function enumerateAllPaths(cfgs) {
  const allPaths = [];
  let globalIndex = 1;

  for (const cfg of cfgs) {
    if (cfg.status !== 'valid') {
      allPaths.push({
        path_id: `PATH-${String(globalIndex++).padStart(3, '0')}`,
        cfg_ref: cfg.cfg_id,
        wsf_flow_ref: cfg.wsf_flow_ref,
        status: 'skipped',
        reason: cfg.status,
      });
      continue;
    }

    const paths = enumeratePaths(cfg);

    for (const path of paths) {
      path.path_id = `PATH-${String(globalIndex++).padStart(3, '0')}`;
      path.cfg_ref = cfg.cfg_id;
      path.wsf_flow_ref = cfg.wsf_flow_ref;
      path.status = path.terminal_outcome === 'truncated' ? 'truncated' : 'enumerated';
      allPaths.push(path);
    }
  }

  return allPaths;
}

module.exports = { enumerateAllPaths };
