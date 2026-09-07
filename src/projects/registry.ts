import type { ProjectEntryConfig, ProjectsMap } from "../types.js";

export function normalizeProjectEntry(entry: string | ProjectEntryConfig): ProjectEntryConfig {
  return typeof entry === "string" ? { path: entry } : entry;
}

export function lookupProjectEntry(project: string, projects: ProjectsMap): ProjectEntryConfig | undefined {
  const entry = projects[project];
  return entry === undefined ? undefined : normalizeProjectEntry(entry);
}
