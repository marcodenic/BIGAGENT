type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

// A matcher group may hold both our hook and unrelated user hooks. Remove
// only owned children and keep the group's matcher and other metadata.
export function removeNestedHooks(settings: unknown, events: readonly string[], managed: (hook: Json, group: Json) => boolean): Json {
  const root = { ...object(settings) };
  const hooks = { ...object(root.hooks) };
  for (const event of events) {
    const entries = hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`);
    const retained = entries.flatMap((value) => {
      const group = object(value);
      if (!Array.isArray(group.hooks)) return [value];
      const children = group.hooks.filter((hook) => !managed(object(hook), group));
      if (children.length === group.hooks.length) return [value];
      return children.length ? [{ ...group, hooks: children }] : [];
    });
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) root.hooks = hooks;
  else delete root.hooks;
  return root;
}
