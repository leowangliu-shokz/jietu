import path from "node:path";

export function safeJoin(root, requestedPath) {
  const rootResolved = path.resolve(root);
  const cleanPath = String(requestedPath || "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(rootResolved, cleanPath);
  const relative = path.relative(rootResolved, resolved);

  if (!relative) {
    return resolved;
  }

  return isParentTraversal(relative) || path.isAbsolute(relative)
    ? null
    : resolved;
}

function isParentTraversal(relativePath) {
  return relativePath.split(path.sep)[0] === "..";
}
