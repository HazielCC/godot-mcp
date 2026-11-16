/**
 * Recovery tools that do not need Godot: checkpoints of the project's files, a static check of resource
 * references, repairs for moved files, moving a file with its references, and explanations of errors.
 * Everything here reads and writes text files, so it works on a machine without Godot.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

// ----------------------------------------------------------------------------------------- files

/** Files of the project as paths relative to it, with forward slashes. Hidden folders (.godot, .git) are skipped. */
export function walkProject(root: string, options: { includeAddons?: boolean } = {}): string[] {
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (relative === 'addons' && !options.includeAddons) {
          continue;
        }
        visit(join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        found.push(relative);
      }
    }
  };
  visit(root, '');
  return found;
}

function extensionOf(file: string): string {
  return extname(file).slice(1).toLowerCase();
}

// ----------------------------------------------------------------------------------------- checkpoints

export const CHECKPOINT_FOLDER = '.godot/mcp_checkpoints';
const CHECKPOINT_EXTENSIONS = ['tscn', 'tres', 'res', 'gd', 'gdshader', 'godot', 'cfg', 'json', 'import', 'uid'];
const MAX_CHECKPOINT_FILES = 5000;
const MAX_CHECKPOINT_BYTES = 100 * 1024 * 1024;
const MAX_CHECKPOINTS = 20;

export interface CheckpointManifest {
  id: string;
  label: string;
  createdAt: string;
  extensions: string[];
  paths: string[];
  files: { path: string; size: number }[];
}

function checkpointRoot(root: string): string {
  return join(root, CHECKPOINT_FOLDER);
}

/** Files that a checkpoint with these options covers. */
function checkpointScope(root: string, extensions: string[], paths: string[]): string[] {
  const wanted = paths.map((p) => p.replace(/\\/g, '/').replace(/^res:\/\//, '').replace(/\/+$/, ''));
  return walkProject(root, { includeAddons: wanted.some((p) => p === 'addons' || p.startsWith('addons/')) }).filter((file) => {
    if (!extensions.includes(extensionOf(file))) {
      return false;
    }
    return wanted.length === 0 || wanted.some((p) => file === p || file.startsWith(`${p}/`));
  });
}

export function createCheckpoint(root: string, options: { label?: string; paths?: string[]; extensions?: string[] } = {}): CheckpointManifest {
  const extensions = options.extensions ?? CHECKPOINT_EXTENSIONS;
  const paths = options.paths ?? [];
  const files = checkpointScope(root, extensions, paths);
  if (files.length > MAX_CHECKPOINT_FILES) {
    throw new Error(`The checkpoint would hold ${files.length} files; the limit is ${MAX_CHECKPOINT_FILES}. Give paths to cover less.`);
  }
  let total = 0;
  const listed = files.map((file) => {
    const size = statSync(join(root, file)).size;
    total += size;
    return { path: file, size };
  });
  if (total > MAX_CHECKPOINT_BYTES) {
    throw new Error(`The checkpoint would hold ${Math.round(total / 1048576)} MB; the limit is ${MAX_CHECKPOINT_BYTES / 1048576} MB. Give paths to cover less.`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const id = `${stamp}-${Math.random().toString(36).slice(2, 5)}`;
  const folder = join(checkpointRoot(root), id);
  for (const file of files) {
    const target = join(folder, 'files', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  const manifest: CheckpointManifest = { id, label: options.label ?? '', createdAt: new Date().toISOString(), extensions, paths, files: listed };
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Keep the newest checkpoints only.
  const all = listCheckpoints(root);
  for (const old of all.slice(MAX_CHECKPOINTS)) {
    rmSync(join(checkpointRoot(root), old.id), { recursive: true, force: true });
  }
  return manifest;
}

/** Checkpoints, newest first. */
export function listCheckpoints(root: string): CheckpointManifest[] {
  const folder = checkpointRoot(root);
  if (!existsSync(folder)) {
    return [];
  }
  const manifests: CheckpointManifest[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name, 'manifest.json');
    if (entry.isDirectory() && existsSync(file)) {
      try {
        manifests.push(JSON.parse(readFileSync(file, 'utf8')) as CheckpointManifest);
      } catch {
        // A damaged manifest is not a usable checkpoint.
      }
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findCheckpoint(root: string, id: string): CheckpointManifest | undefined {
  const all = listCheckpoints(root);
  return id === 'latest' ? all[0] : all.find((c) => c.id === id);
}

/** How the project differs from a checkpoint. */
export function diffCheckpoint(root: string, manifest: CheckpointManifest): { changed: string[]; removed: string[]; added: string[]; unchanged: number } {
  const folder = join(checkpointRoot(root), manifest.id, 'files');
  const changed: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  for (const { path } of manifest.files) {
    const current = join(root, path);
    if (!existsSync(current)) {
      removed.push(path);
    } else if (!readFileSync(current).equals(readFileSync(join(folder, path)))) {
      changed.push(path);
    } else {
      unchanged++;
    }
  }
  const known = new Set(manifest.files.map((f) => f.path));
  const added = checkpointScope(root, manifest.extensions, manifest.paths).filter((file) => !known.has(file));
  return { changed, removed, added, unchanged };
}

/**
 * Put the files of a checkpoint back. A checkpoint of the current state is made first, so the restore can be
 * undone. Files created after the checkpoint are removed only with deleteNew.
 */
export function restoreCheckpoint(root: string, manifest: CheckpointManifest, options: { deleteNew?: boolean } = {}): {
  restored: string[];
  removed: string[];
  unchanged: number;
  undoCheckpoint: string;
} {
  const difference = diffCheckpoint(root, manifest);
  const undo = createCheckpoint(root, { label: `before restoring ${manifest.id}`, paths: manifest.paths, extensions: manifest.extensions });
  const folder = join(checkpointRoot(root), manifest.id, 'files');
  const restored = [...difference.changed, ...difference.removed];
  for (const file of restored) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(folder, file), join(root, file));
  }
  const removed: string[] = [];
  if (options.deleteNew) {
    for (const file of difference.added) {
      rmSync(join(root, file), { force: true });
      removed.push(file);
    }
  }
  return { restored, removed, unchanged: difference.unchanged, undoCheckpoint: undo.id };
}

export function deleteCheckpoint(root: string, id: string): boolean {
  const folder = join(checkpointRoot(root), id);
  if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{3}$/.test(id) || !existsSync(folder)) {
    return false;
  }
  rmSync(folder, { recursive: true, force: true });
  return true;
}

// ----------------------------------------------------------------------------------------- parsing

export interface Section {
  kind: string;
  attrs: Record<string, string>;
  line: number;
  props: Map<string, { value: string; line: number }>;
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g)) {
    attributes[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attributes;
}

/** The sections of a .tscn, .tres or project.godot file, each with its header attributes and its first-line properties. */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const header = /^\[(\w+)(.*)\]$/.exec(line);
    if (header) {
      current = { kind: header[1], attrs: parseAttributes(header[2]), line: index + 1, props: new Map() };
      sections.push(current);
      return;
    }
    if (line.startsWith('[')) {
      current = undefined;
      return;
    }
    const property = /^([^=\s;#][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (property && current) {
      current.props.set(property[1], { value: property[2], line: index + 1 });
    }
  });
  return sections;
}

function nodeKey(parent: string | undefined, name: string): string {
  if (parent === undefined) {
    return '';
  }
  const base = parent === '.' ? '' : parent;
  return base === '' ? name : `${base}/${name}`;
}

// ----------------------------------------------------------------------------------------- validation

export interface ProjectIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  suggestion?: string;
  /** A change that repair_project can make: replace this res:// path with another. */
  fix?: { from: string; to: string };
}

interface ProjectIndex {
  files: string[];
  byBasename: Map<string, string[]>;
  byUid: Map<string, string>;
}

function buildIndex(root: string, files: string[]): ProjectIndex {
  const byBasename = new Map<string, string[]>();
  const byUid = new Map<string, string>();
  for (const file of files) {
    const name = basename(file);
    byBasename.set(name, [...(byBasename.get(name) ?? []), file]);
    const extension = extensionOf(file);
    try {
      if (extension === 'uid') {
        const uid = readFileSync(join(root, file), 'utf8').trim();
        if (uid.startsWith('uid://')) {
          byUid.set(uid, file.slice(0, -'.uid'.length));
        }
      } else if (extension === 'import') {
        const text = readFileSync(join(root, file), 'utf8');
        const uid = /^uid="(uid:\/\/[^"]+)"/m.exec(text)?.[1];
        if (uid) {
          byUid.set(uid, file.slice(0, -'.import'.length));
        }
      } else if (extension === 'tscn' || extension === 'tres') {
        const head = readFileSync(join(root, file), 'utf8').slice(0, 400);
        const uid = /^\[gd_(?:scene|resource)[^\]]*\suid="(uid:\/\/[^"]+)"/m.exec(head)?.[1];
        if (uid) {
          byUid.set(uid, file);
        }
      }
    } catch {
      // A file that cannot be read does not give a uid.
    }
  }
  return { files, byBasename, byUid };
}

/** Where a missing file probably went: the file with its uid, or the only file with the same name. */
function findMoved(index: ProjectIndex, missing: string, uid: string | undefined): { path?: string; candidates: string[] } {
  if (uid && index.byUid.has(uid) && index.byUid.get(uid) !== missing) {
    return { path: index.byUid.get(uid), candidates: [] };
  }
  const same = (index.byBasename.get(basename(missing)) ?? []).filter((file) => file !== missing);
  return same.length === 1 ? { path: same[0], candidates: [] } : { candidates: same };
}

const FILE_CHECK_EXTENSIONS = ['tscn', 'tres'];

export function validateProject(root: string, options: { includeAddons?: boolean } = {}): { issues: ProjectIssue[]; filesChecked: number; counts: Record<string, number> } {
  const files = walkProject(root, { includeAddons: options.includeAddons });
  const index = buildIndex(root, files);
  const issues: ProjectIssue[] = [];
  const scriptFunctions = new Map<string, Set<string>>();
  const exists = (resPath: string): boolean => resPath.startsWith('res://') && existsSync(join(root, resPath.slice('res://'.length)));

  const missingFile = (file: string, line: number | undefined, resPath: string, uid: string | undefined, what: string): void => {
    const rel = resPath.slice('res://'.length);
    const moved = findMoved(index, rel, uid);
    issues.push({
      file,
      line,
      severity: 'error',
      kind: 'missing_file',
      message: `${what} points to ${resPath}, which does not exist`,
      suggestion: moved.path
        ? `It seems to have moved to res://${moved.path}; repair_project can update the path`
        : moved.candidates.length > 0
          ? `Several files have that name: ${moved.candidates.slice(0, 4).map((c) => `res://${c}`).join(', ')}`
          : 'Restore the file, or remove the reference',
      fix: moved.path ? { from: resPath, to: `res://${moved.path}` } : undefined,
    });
  };

  const functionsOf = (scriptRel: string): Set<string> | undefined => {
    if (!scriptFunctions.has(scriptRel)) {
      const path = join(root, scriptRel);
      scriptFunctions.set(scriptRel, existsSync(path) ? new Set([...readFileSync(path, 'utf8').matchAll(/^\s*(?:static\s+)?func\s+(\w+)/gm)].map((m) => m[1])) : new Set());
    }
    const set = scriptFunctions.get(scriptRel)!;
    return existsSync(join(root, scriptRel)) ? set : undefined;
  };

  for (const file of files) {
    const extension = extensionOf(file);
    const text = extension === 'tscn' || extension === 'tres' || extension === 'gd' || file === 'project.godot' ? readFileSync(join(root, file), 'utf8') : '';

    if (FILE_CHECK_EXTENSIONS.includes(extension)) {
      const sections = parseSections(text);
      const external = new Map<string, { type: string; path: string; uid?: string }>();
      const subIds = new Set<string>();
      for (const section of sections) {
        if (section.kind === 'ext_resource') {
          const id = section.attrs.id ?? '';
          if (external.has(id)) {
            issues.push({ file, line: section.line, severity: 'error', kind: 'duplicate_id', message: `ext_resource id ${id} is used twice`, suggestion: 'Give each external resource its own id' });
          }
          external.set(id, { type: section.attrs.type ?? '', path: section.attrs.path ?? '', uid: section.attrs.uid });
          if ((section.attrs.path ?? '').startsWith('res://') && !exists(section.attrs.path)) {
            missingFile(file, section.line, section.attrs.path, section.attrs.uid, `The ${section.attrs.type ?? 'resource'} ext_resource ${id}`);
          }
        } else if (section.kind === 'sub_resource') {
          subIds.add(section.attrs.id ?? '');
        }
      }

      // References to ids that are not declared.
      const usedExternal = new Set<string>();
      for (const section of sections) {
        const values = [...section.props.values()];
        if (section.attrs.instance) {
          values.push({ value: section.attrs.instance, line: section.line });
        }
        for (const { value, line } of values) {
          for (const match of value.matchAll(/(ExtResource|SubResource)\("([^"]+)"\)/g)) {
            if (match[1] === 'ExtResource') {
              usedExternal.add(match[2]);
              if (!external.has(match[2])) {
                issues.push({ file, line, severity: 'error', kind: 'undefined_id', message: `ExtResource("${match[2]}") is not declared in this file`, suggestion: 'Add the [ext_resource] line, or remove the reference' });
              }
            } else if (!subIds.has(match[2])) {
              issues.push({ file, line, severity: 'error', kind: 'undefined_id', message: `SubResource("${match[2]}") is not declared in this file`, suggestion: 'Add the [sub_resource] section, or remove the reference' });
            }
          }
        }
      }
      for (const [id, resource] of external) {
        if (!usedExternal.has(id) && extension === 'tscn' && resource.path !== '') {
          issues.push({ file, severity: 'info', kind: 'unused_resource', message: `ext_resource ${id} (${resource.path}) is never used`, suggestion: 'Remove it to keep the scene clean' });
        }
      }

      if (extension === 'tscn') {
        const nodes = sections.filter((s) => s.kind === 'node');
        const inherited = nodes.length > 0 && nodes[0].attrs.instance !== undefined && nodes[0].attrs.parent === undefined;
        const keys = new Map<string, Section>();
        for (const node of nodes) {
          const key = nodeKey(node.attrs.parent, node.attrs.name ?? '');
          if (keys.has(key) && key !== '') {
            issues.push({ file, line: node.line, severity: 'error', kind: 'duplicate_node', message: `Two nodes are called ${key}`, suggestion: 'Rename one of them' });
          }
          keys.set(key, node);
        }
        if (!inherited) {
          for (const node of nodes.slice(1)) {
            const parent = node.attrs.parent;
            if (parent !== undefined && parent !== '.' && !keys.has(parent)) {
              issues.push({ file, line: node.line, severity: 'error', kind: 'orphan_node', message: `Node ${node.attrs.name} has the parent ${parent}, which is not in the scene`, suggestion: 'Fix the parent path, or add the parent node' });
            }
          }
        }
        for (const connection of sections.filter((s) => s.kind === 'connection')) {
          const from = connection.attrs.from ?? '';
          const to = connection.attrs.to ?? '';
          const toKey = to === '.' ? '' : to;
          const fromKey = from === '.' ? '' : from;
          if (!inherited && !keys.has(fromKey)) {
            issues.push({ file, line: connection.line, severity: 'error', kind: 'bad_connection', message: `Signal ${connection.attrs.signal} comes from ${from}, which is not in the scene`, suggestion: 'Fix the path or remove the connection' });
            continue;
          }
          if (!inherited && !keys.has(toKey)) {
            issues.push({ file, line: connection.line, severity: 'error', kind: 'bad_connection', message: `Signal ${connection.attrs.signal} goes to ${to}, which is not in the scene`, suggestion: 'Fix the path or remove the connection' });
            continue;
          }
          const script = keys.get(toKey)?.props.get('script')?.value;
          const scriptId = script ? /ExtResource\("([^"]+)"\)/.exec(script)?.[1] : undefined;
          const scriptPath = scriptId ? external.get(scriptId)?.path : undefined;
          const method = connection.attrs.method ?? '';
          if (scriptPath?.startsWith('res://') && scriptPath.endsWith('.gd') && method.startsWith('_on_')) {
            const functions = functionsOf(scriptPath.slice('res://'.length));
            if (functions && !functions.has(method)) {
              issues.push({ file, line: connection.line, severity: 'warning', kind: 'missing_method', message: `Signal ${connection.attrs.signal} calls ${method}, which ${scriptPath} does not define`, suggestion: 'Add the function, or reconnect the signal' });
            }
          }
        }
      }
    } else if (extension === 'gd') {
      text.split(/\r?\n/).forEach((raw, i) => {
        for (const match of raw.matchAll(/\b(?:preload|load)\(\s*"(res:\/\/[^"]+)"\s*\)|\bextends\s+"(res:\/\/[^"]+)"/g)) {
          const target = match[1] ?? match[2];
          if (!exists(target)) {
            missingFile(file, i + 1, target, undefined, 'The script');
          }
        }
      });
    } else if (file === 'project.godot') {
      const sections = parseSections(text);
      const checkPath = (value: string | undefined, line: number, what: string): void => {
        const path = value?.replace(/^"|"$/g, '').replace(/^\*/, '');
        if (path?.startsWith('res://') && !exists(path)) {
          missingFile(file, line, path, undefined, what);
        }
      };
      for (const section of sections) {
        if (section.kind === 'autoload') {
          for (const [name, { value, line }] of section.props) {
            checkPath(value, line, `The autoload ${name}`);
          }
        }
        if (section.kind === 'application') {
          const main = section.props.get('run/main_scene');
          if (main) {
            checkPath(main.value, main.line, 'The main scene');
          }
          const icon = section.props.get('config/icon');
          if (icon) {
            checkPath(icon.value, icon.line, 'The project icon');
          }
        }
        if (section.kind === 'editor_plugins') {
          const enabled = section.props.get('enabled');
          for (const match of enabled?.value.matchAll(/"(res:\/\/[^"]+)"/g) ?? []) {
            checkPath(match[1], enabled!.line, 'An enabled plugin');
          }
        }
      }
    }
  }

  const counts: Record<string, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    counts[issue.severity]++;
  }
  return { issues, filesChecked: files.length, counts };
}

// ----------------------------------------------------------------------------------------- repair

/**
 * Fix the paths that validateProject can resolve: a missing file that moved. A checkpoint is made first when
 * the repair is applied. Returns what was (or would be) changed and what could not be resolved.
 */
export function repairProject(root: string, options: { apply: boolean }): {
  changes: { file: string; from: string; to: string; occurrences: number }[];
  unresolved: ProjectIssue[];
  checkpoint?: string;
} {
  const { issues } = validateProject(root);
  const byFile = new Map<string, Map<string, string>>();
  for (const issue of issues) {
    if (issue.fix) {
      const fixes = byFile.get(issue.file) ?? new Map<string, string>();
      fixes.set(issue.fix.from, issue.fix.to);
      byFile.set(issue.file, fixes);
    }
  }
  const unresolved = issues.filter((issue) => issue.kind === 'missing_file' && !issue.fix);
  const changes: { file: string; from: string; to: string; occurrences: number }[] = [];
  let checkpoint: string | undefined;
  if (options.apply && byFile.size > 0) {
    checkpoint = createCheckpoint(root, { label: 'before repair_project' }).id;
  }
  for (const [file, fixes] of byFile) {
    let text = readFileSync(join(root, file), 'utf8');
    for (const [from, to] of fixes) {
      const quoted = `"${from}"`;
      const occurrences = text.split(quoted).length - 1;
      if (occurrences > 0) {
        changes.push({ file, from, to, occurrences });
        text = text.split(quoted).join(`"${to}"`);
      }
    }
    if (options.apply) {
      writeFileSync(join(root, file), text);
    }
  }
  return { changes, unresolved, checkpoint };
}

// ----------------------------------------------------------------------------------------- move

const REFERENCE_EXTENSIONS = ['tscn', 'tres', 'gd', 'gdshader', 'godot', 'cfg', 'import', 'json'];

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Move a file or folder and update every res:// reference to it in the project's text files, together with the
 * .import and .uid files that go with it. A checkpoint is made first when the move is applied.
 */
export function moveResource(root: string, from: string, to: string, options: { apply: boolean }): {
  moved: string[];
  updates: { file: string; occurrences: number }[];
  checkpoint?: string;
} {
  const source = join(root, from);
  if (!existsSync(source)) {
    throw new Error(`Nothing to move: ${from} does not exist`);
  }
  if (existsSync(join(root, to))) {
    throw new Error(`${to} already exists`);
  }
  const isFolder = statSync(source).isDirectory();
  if (isFolder && (to === from || to.startsWith(`${from}/`))) {
    throw new Error('A folder cannot be moved into itself');
  }

  const moved = isFolder ? [from] : [from, ...[`${from}.import`, `${from}.uid`].filter((side) => existsSync(join(root, side)))];
  const pattern = isFolder
    ? new RegExp(`res://${escapeForRegExp(from)}(?=/)`, 'g')
    : new RegExp(`res://${escapeForRegExp(from)}(?![A-Za-z0-9_./-])`, 'g');
  const replacement = `res://${to}`;

  const candidates = walkProject(root, { includeAddons: true }).filter((file) => REFERENCE_EXTENSIONS.includes(extensionOf(file)));
  const updates: { file: string; occurrences: number }[] = [];
  const rewritten = new Map<string, string>();
  for (const file of candidates) {
    const text = readFileSync(join(root, file), 'utf8');
    const occurrences = (text.match(pattern) ?? []).length;
    if (occurrences > 0) {
      updates.push({ file, occurrences });
      rewritten.set(file, text.replace(pattern, replacement));
    }
  }

  let checkpoint: string | undefined;
  if (options.apply) {
    checkpoint = createCheckpoint(root, { label: `before moving ${from}` }).id;
    for (const [file, text] of rewritten) {
      writeFileSync(join(root, file), text);
    }
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(source, join(root, to));
    for (const side of moved.slice(1)) {
      renameSync(join(root, side), join(root, `${to}${side.slice(from.length)}`));
    }
    // The files that moved and were rewritten now live at their new place.
    for (const update of updates) {
      const wasMoved = isFolder ? update.file.startsWith(`${from}/`) : moved.includes(update.file);
      if (wasMoved) {
        update.file = `${to}${update.file.slice(from.length)}`;
      }
    }
  }
  return { moved, updates, checkpoint };
}

// ----------------------------------------------------------------------------------------- explain errors

interface ErrorRule {
  id: string;
  pattern: RegExp;
  title: string;
  explanation: string;
  fixes: string[];
}

const ERROR_RULES: ErrorRule[] = [
  {
    id: 'null_instance',
    pattern: /Invalid (?:call|access to property or key)[^]*?(?:base object of type|in base) '(?:Nil|null instance)'|on a null value|Cannot (?:call|access)[^]*null/i,
    title: 'A variable is null when the code uses it',
    explanation: 'The code calls a method or reads a property on something that is null: a node that was not found, a variable that was never set, or an object that was freed.',
    fixes: ['Check how the variable gets its value: get_node, $Path, %UniqueName, an @onready var, or an exported variable that is empty in the scene', 'Use is_instance_valid(x) before using an object that may have been freed', 'Do not use @onready variables before _ready runs (for example from _init)'],
  },
  {
    id: 'node_not_found',
    pattern: /Node not found: "?([^"\n]+)"?|get_node[^]*not found/i,
    title: 'get_node cannot find the node',
    explanation: 'The path does not lead to a node from where the script is attached. Paths are relative to the node that has the script, not to the scene root.',
    fixes: ['Compare the path with read_scene (node paths there start with the root name; get_node paths do not)', 'The node may be added later or in another scene: wait for it, or use a group or a signal', 'A unique name (%Name) works from anywhere in the scene'],
  },
  {
    id: 'nonexistent_function',
    pattern: /Nonexistent function '(\w+)' in base '([^']+)'/i,
    title: 'The method does not exist on that object',
    explanation: 'The object is of a type that has no method with that name: a typo, a method from another class, or the wrong object.',
    fixes: ['Check the spelling and the class of the object (print(x.get_class()))', 'If the object is a custom class, check that its script has that func and that the script is attached', 'In Godot 4 several methods were renamed (for example instance() is instantiate())'],
  },
  {
    id: 'identifier_not_declared',
    pattern: /Identifier "?'?(\w+)'?"? not declared in the current scope/i,
    title: 'A name is used that does not exist here',
    explanation: 'The script uses a variable, constant, class or autoload that is not declared in that scope.',
    fixes: ['Check the spelling and where the variable is declared (a variable inside a function is not visible in another)', 'For an autoload, check project.godot [autoload] and the name', 'For a class_name, check that its file has no errors, because Godot ignores a script that fails to compile'],
  },
  {
    id: 'parse_error',
    pattern: /Parse Error: ?(.*)|Expected [^\n]+|Unexpected [^\n]+/i,
    title: 'The script has a syntax error',
    explanation: 'GDScript cannot read the line: a missing colon, bad indentation, a missing parenthesis, or a keyword from another version.',
    fixes: ['Open the line in the error and the one before it: the real mistake is often just above', 'Use only tabs or only spaces for indentation', 'Run check_script on the file to see every parse error'],
  },
  {
    id: 'type_assignment',
    pattern: /Trying to assign value of type '([^']+)' to a variable of type '([^']+)'|Invalid assignment of property or key '([^']+)' with value of type '([^']+)'/i,
    title: 'A value of the wrong type is being assigned',
    explanation: 'The variable or property has a type, and the value has another that cannot be converted.',
    fixes: ['Convert the value (int(x), float(x), str(x)) or fix the type of the variable', 'A Variant from get_node must be cast with "as" or typed with a typed @onready var', 'For a resource property, assign a loaded resource, not its path'],
  },
  {
    id: 'cannot_infer',
    pattern: /Cannot infer the type of "?'?(\w+)'?"? variable/i,
    title: 'Godot cannot work out the type for :=',
    explanation: 'The value on the right has no fixed type (for example a Variant from a Dictionary or get_node), so := cannot decide.',
    fixes: ['Write the type: var x: int = ...', 'Or cast the value: var x := dict["a"] as int'],
  },
  {
    id: 'index_out_of_bounds',
    pattern: /Index (-?\d+) out of (?:size|range)|Out of bounds get index '([^']+)'|Invalid (?:get|set) index '([^']+)'/i,
    title: 'An index or key is outside the array or dictionary',
    explanation: 'The code reads a position that does not exist: an empty array, an index one too high, or a dictionary key that is missing.',
    fixes: ['Check the size first (if i < arr.size())', 'For dictionaries use .get(key, default) or has(key)', 'Remember that the last index is size - 1'],
  },
  {
    id: 'division_by_zero',
    pattern: /Division by zero|Integer division by zero/i,
    title: 'A division by zero',
    explanation: 'A division or modulo has 0 as the divisor, often a size, a count or a delta that is 0 on the first frame.',
    fixes: ['Check the divisor before dividing', 'Use maxf(x, 0.001) for values that can be 0'],
  },
  {
    id: 'flushing_queries',
    pattern: /Can't change this state while flushing queries|Use call_deferred\(\) or set_deferred\(\)/i,
    title: 'Physics state changed inside a physics callback',
    explanation: 'The code adds, removes or changes a collision shape, body or area while the physics engine is still reporting contacts (for example in body_entered).',
    fixes: ['Use call_deferred("method") or set_deferred("disabled", true)', 'Move the change to the next frame with await get_tree().process_frame'],
  },
  {
    id: 'cannot_open_resource',
    pattern: /Cannot open file '([^']+)'|Failed loading resource: ?([^\s]+)|Resource file not found: ?([^\s]+)|No loader found for resource/i,
    title: 'A file or resource cannot be loaded',
    explanation: 'The path does not exist, was moved or renamed, or the file has not been imported.',
    fixes: ['Run validate_project: it lists missing files and where they moved', 'repair_project can update paths of files that moved', 'Run diagnose_project with runImport so Godot imports the assets'],
  },
  {
    id: 'signal_connection',
    pattern: /Signal '([^']+)' is already connected|Attempt to connect[^\n]*|Method '([^']+)' not found|Cannot connect signal/i,
    title: 'A signal cannot be connected',
    explanation: 'The signal is already connected to that callable, or the target method does not exist.',
    fixes: ['Check is_connected before connecting, or use CONNECT_ONE_SHOT when it fits', 'Check that the method exists on the target and has the right number of arguments'],
  },
  {
    id: 'cyclic_reference',
    pattern: /Cyclic reference|cyclic dependency|circular/i,
    title: 'Two scripts or scenes depend on each other',
    explanation: 'Script A preloads B and B preloads A (or a scene contains itself), so neither can finish loading.',
    fixes: ['Use load() at run time instead of preload() in one of them', 'Use class_name and typed variables without preload', 'A scene cannot instance itself: use a packed scene variable'],
  },
  {
    id: 'freed_object',
    pattern: /previously freed|freed object|Object was freed|Invalid access[^\n]*freed/i,
    title: 'An object that was freed is used',
    explanation: 'The node or object was removed with free() or queue_free() and the code still keeps a reference.',
    fixes: ['Check is_instance_valid(x) before using it', 'Set the variable to null when you free the object', 'Disconnect signals when an object is freed'],
  },
];

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

export interface ErrorExplanation {
  category: string;
  title: string;
  explanation: string;
  fixes: string[];
  matched?: string;
  locations: { file: string; line: number }[];
  context?: { file: string; line: number; lines: { number: number; text: string; here: boolean }[] };
  hints: string[];
}

/** Explain an error message from Godot or from get_debug_output. With a project, it adds the code around the error. */
export function explainError(message: string, root?: string): ErrorExplanation {
  const rule = ERROR_RULES.find((candidate) => candidate.pattern.test(message));
  const locations = [...message.matchAll(/(res:\/\/[^\s:)'"]+):(\d+)/g)].map((m) => ({ file: m[1], line: Number(m[2]) }));
  const explanation: ErrorExplanation = {
    category: rule?.id ?? 'unknown',
    title: rule?.title ?? 'This message is not one of the common ones',
    explanation: rule?.explanation ?? 'No rule matches this message. The location and the code around it are the best clue.',
    fixes: rule?.fixes ?? ['Read the line in the error and the ones before it', 'Search the message in the Godot documentation or the engine issue tracker'],
    matched: rule ? rule.pattern.exec(message)?.[0]?.slice(0, 120) : undefined,
    locations,
    hints: [],
  };

  if (root && locations.length > 0) {
    const first = locations[0];
    const path = join(root, first.file.slice('res://'.length));
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      const from = Math.max(1, first.line - 4);
      const to = Math.min(lines.length, first.line + 4);
      explanation.context = {
        file: first.file,
        line: first.line,
        lines: Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, text: lines[from + i - 1], here: from + i === first.line })),
      };
    }

    // For a node that was not found: which scenes use this script, and which node names are close to the one asked for.
    if (rule?.id === 'node_not_found') {
      const requested = /Node not found: "?([^"\n]+)"?/i.exec(message)?.[1]?.trim();
      const last = requested?.split('/').pop()?.replace(/^[%$]/, '');
      if (last) {
        const names = new Set<string>();
        for (const file of walkProject(root).filter((f) => extensionOf(f) === 'tscn')) {
          const text = readFileSync(join(root, file), 'utf8');
          if (text.includes(first.file)) {
            for (const section of parseSections(text)) {
              if (section.kind === 'node' && section.attrs.name) {
                names.add(section.attrs.name);
              }
            }
            explanation.hints.push(`The script is used in res://${file}`);
          }
        }
        const close = [...names].map((name) => ({ name, distance: levenshtein(name.toLowerCase(), last.toLowerCase()) })).filter((c) => c.distance <= 3).sort((a, b) => a.distance - b.distance);
        if (names.size > 0 && !names.has(last)) {
          explanation.hints.push(close.length > 0 ? `No node is called ${last} in those scenes. Close names: ${close.slice(0, 3).map((c) => c.name).join(', ')}` : `No node is called ${last} in the scenes that use this script`);
        }
      }
    }
  }
  return explanation;
}
