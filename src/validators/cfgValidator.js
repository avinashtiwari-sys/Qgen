/**
 * Pure structural validation of a CFG. No LLM involved.
 * Returns { valid: bool, errors: string[] }
 */
function validateCFG(cfg) {
  const errors = [];
  const { nodes = [], edges = [] } = cfg;

  const nodeMap = new Map(nodes.map(n => [n.node_id, n]));
  const edgesByFrom = new Map();
  const edgesByTo = new Map();

  for (const edge of edges) {
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    if (!edgesByTo.has(edge.to))   edgesByTo.set(edge.to, []);
    edgesByFrom.get(edge.from).push(edge);
    edgesByTo.get(edge.to).push(edge);
  }

  // 1. Exactly one START
  const startNodes = nodes.filter(n => n.type === 'START');
  if (startNodes.length !== 1) errors.push(`Expected 1 START node, found ${startNodes.length}`);

  // 2. At least one END
  const endNodes = nodes.filter(n => n.type === 'END');
  if (endNodes.length === 0) errors.push('No END node found');

  // 3. All edge references point to existing nodes
  for (const edge of edges) {
    if (!nodeMap.has(edge.from)) errors.push(`Edge references unknown from-node: ${edge.from}`);
    if (!nodeMap.has(edge.to))   errors.push(`Edge references unknown to-node: ${edge.to}`);
  }

  for (const node of nodes) {
    const outgoing = edgesByFrom.get(node.node_id) || [];
    const incoming = edgesByTo.get(node.node_id) || [];

    if (node.type === 'END') {
      // END nodes must have no outgoing edges
      if (outgoing.length > 0) errors.push(`END node ${node.node_id} has outgoing edges`);
      continue;
    }

    if (node.type === 'START') {
      if (outgoing.length !== 1) errors.push(`START node must have exactly 1 outgoing edge`);
      continue;
    }

    // 4. Non-END nodes must have at least one outgoing edge
    if (outgoing.length === 0) errors.push(`Node ${node.node_id} (${node.type}) has no outgoing edges`);

    // 5. Non-START nodes must have at least one incoming edge
    if (incoming.length === 0) errors.push(`Node ${node.node_id} (${node.type}) has no incoming edges (orphan)`);

    // 6. DECISION nodes need >= 2 outgoing edges
    if (node.type === 'DECISION' && outgoing.length < 2) {
      errors.push(`DECISION node ${node.node_id} must have >= 2 outgoing edges, found ${outgoing.length}`);
    }

    // 7. ACTION and VERIFY nodes need exactly 1 outgoing edge
    if ((node.type === 'ACTION' || node.type === 'VERIFY') && outgoing.length !== 1) {
      errors.push(`${node.type} node ${node.node_id} must have exactly 1 outgoing edge, found ${outgoing.length}`);
    }
  }

  // 8. All nodes reachable from START (BFS forward)
  if (startNodes.length === 1) {
    const reachable = bfs(startNodes[0].node_id, edgesByFrom);
    for (const node of nodes) {
      if (node.type !== 'START' && !reachable.has(node.node_id)) {
        errors.push(`Node ${node.node_id} is not reachable from START`);
      }
    }
  }

  // 9. All nodes can reach an END (BFS reverse)
  if (endNodes.length > 0) {
    const reverseEdges = new Map();
    for (const edge of edges) {
      if (!reverseEdges.has(edge.to)) reverseEdges.set(edge.to, []);
      reverseEdges.get(edge.to).push({ from: edge.to, to: edge.from });
    }
    const canReachEnd = new Set();
    const queue = endNodes.map(n => n.node_id);
    queue.forEach(id => canReachEnd.add(id));
    while (queue.length) {
      const curr = queue.shift();
      for (const edge of (reverseEdges.get(curr) || [])) {
        if (!canReachEnd.has(edge.to)) {
          canReachEnd.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of nodes) {
      if (node.type !== 'END' && !canReachEnd.has(node.node_id)) {
        errors.push(`Node ${node.node_id} has no path to any END node`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function bfs(startId, edgesByFrom) {
  const visited = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const curr = queue.shift();
    for (const edge of (edgesByFrom.get(curr) || [])) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return visited;
}

module.exports = { validateCFG };
