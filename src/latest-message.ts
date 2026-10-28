interface Node {
  children?: Node[];
  lastMessage?: { role?: string };
  render?: (width: number) => string[];
}

// pi does not pass message identity to Markdown transformers.
// Scope the transformer to the last assistant component while it renders.
export function latestMessageScope(root: Node) {
  let active: Node | undefined;
  let latest: Node | undefined;
  const originals = new Map<Node, NonNullable<Node["render"]>>();
  return {
    includesCurrent: () => active !== undefined && active === latest,
    update() {
      latest = undefined;
      const visit = (node: Node) => {
        if (node.lastMessage?.role === "assistant" && node.render) {
          latest = node;
          if (!originals.has(node)) {
            const original = node.render;
            originals.set(node, original);
            node.render = function (width) {
              const previous = active;
              active = node;
              try { return original.call(this, width); }
              finally { active = previous; }
            };
          }
        }
        for (const child of node.children ?? []) visit(child);
      };
      visit(root);
    },
    dispose() {
      for (const [node, original] of originals) node.render = original;
      originals.clear();
      active = latest = undefined;
    },
  };
}
