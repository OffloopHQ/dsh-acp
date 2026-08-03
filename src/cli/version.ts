declare const __DSH_ACP_VERSION__: string | undefined;

/** Replaced with package.json version by release builds. */
export const DSH_ACP_VERSION =
  typeof __DSH_ACP_VERSION__ === "string"
    ? __DSH_ACP_VERSION__
    : (process.env["npm_package_version"] ?? "0.0.0-dev");
