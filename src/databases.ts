import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionContext, window as Window } from 'vscode';

/**
 * databases.ts
 * ------------
 * Managing state of what the current database is, and what other
 * databases have been recently selected.
 *
 * The source of truth of the current state resides inside the
 * `TreeDataProvider` subclass below. Not sure I love this, since it
 * feels like mixing model and view a bit, but it works ok for now.
 */

/**
 * The name of the key in the workspaceState dictionary in which we
 * persist the current database across sessions. We could instead
 * decide to persist more information (e.g. all 'recently chosen
 * databases') or less information, as eclipse does.
 */
const CURRENT_DB: string = 'currentDatabase';

type ThemableIconPath = { light: string, dark: string } | string;

/**
 * Path to icons to display next to currently selected database.
 */
const SELECTED_DATABASE_ICON: ThemableIconPath = {
  light: 'media/check-light-mode.svg',
  dark: 'media/check-dark-mode.svg',
};

/**
 * Path to icon to display next to an invalid database.
 */
const INVALID_DATABASE_ICON: ThemableIconPath = 'media/red-x.svg';

function joinThemableIconPath(base: string, iconPath: ThemableIconPath): ThemableIconPath {
  if (typeof iconPath == 'object')
    return {
      light: path.join(base, iconPath.light),
      dark: path.join(base, iconPath.dark)
    };
  else
    return path.join(base, iconPath);
}

/**
 * Display file selection dialog. Expects the user to choose a
 * snapshot directory, which should be the parent directory of a
 * directory of the form `db-[language]`, for example, `db-cpp`.
 *
 * XXX: no validation is done other than checking the directory name
 * to make sure it really is a database directory.
 */
export async function chooseDatabaseDir(ctx: ExtensionContext): Promise<vscode.Uri | undefined> {
  const chosen = await Window.showOpenDialog(
    {
      openLabel: 'Choose Database',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
  if (chosen == undefined) {
    return undefined;
  }
  else {
    return chosen[0];
  }
}

/**
 * An error thrown when we cannot find a database in a putative
 * snapshot directory.
 */
class NoDatabaseError extends Error {

}

/**
 * One item in the user-displayed list of databases. Probably name
 * should be computed from a nearby .project file if it exists.
 */
export class DatabaseItem {
  snapshotUri: vscode.Uri;
  dbUri: vscode.Uri;
  srcRoot: vscode.Uri | undefined;
  name: string; // this is supposed to be human-readable, appears in interface
  constructor(uri: vscode.Uri) {
    this.snapshotUri = uri;
    this.name = path.basename(uri.fsPath);
    const dbRelativePaths = DatabaseItem.findDb(uri);

    if (dbRelativePaths.length == 0) {
      throw new NoDatabaseError(`${uri.fsPath} doesn't appear to be a valid snapshot directory.`);
    }
    else {
      const dbAbsolutePath = path.join(uri.fsPath, dbRelativePaths[0]);
      if (dbRelativePaths.length > 1) {
        vscode.window.showWarningMessage(`Found multiple database directories in snapshot, using ${dbAbsolutePath}`);
      }
      this.dbUri = vscode.Uri.file(dbAbsolutePath);
      fs.exists(path.join(uri.fsPath, 'src'), (exists) => {
        if (exists) {
          this.srcRoot = vscode.Uri.file(path.join(uri.fsPath, 'src'));
        } else {
          console.log(`Could not determine source root for database ${uri}. Assuming paths are absolute.`);
          this.srcRoot = undefined;
        }
      });
    }
  }

  private static findDb(uri: vscode.Uri) {
    let files = fs.readdirSync(uri.fsPath);
    let matches: string[] = [];
    files.forEach((file) => {
      if (file.startsWith('db-')) {
        matches.push(file);
      }
    })
    return matches
  }
}

/**
 * Tree data provider for the databases view.
 */
class DatabaseTreeDataProvider implements vscode.TreeDataProvider<DatabaseItem> {

  /**
   * XXX: This idiom for how to get a `.fire()`-able event emitter was
   * cargo culted from another vscode extension. It seems rather
   * involved and I hope there's something better that can be done
   * instead.
   */
  private _onDidChangeTreeData: vscode.EventEmitter<DatabaseItem | undefined> = new vscode.EventEmitter<DatabaseItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<DatabaseItem | undefined> = this._onDidChangeTreeData.event;

  private ctx: ExtensionContext;
  private databases: DatabaseItem[] = [];

  /**
   * When not undefined, must be reference-equal to an item in `this.databases`.
   */
  private current: DatabaseItem | undefined;

  constructor(ctx: ExtensionContext, databases: DatabaseItem[], current: DatabaseItem | undefined) {
    this.ctx = ctx;
    this.databases = databases;
    this.current = current;
  }

  getTreeItem(element: DatabaseItem): vscode.TreeItem {
    const it = new vscode.TreeItem(element.name);
    if (element == this.current)
      it.iconPath = joinThemableIconPath(this.ctx.extensionPath, SELECTED_DATABASE_ICON);
    it.tooltip = element.snapshotUri.fsPath;
    return it;
  }

  getChildren(element?: DatabaseItem): vscode.ProviderResult<DatabaseItem[]> {
    if (element == undefined) {
      return this.databases;
    }
    else {
      return [];
    }
  }

  getParent(element: DatabaseItem): vscode.ProviderResult<DatabaseItem> {
    return null;
  }

  getCurrent(): DatabaseItem | undefined {
    return this.current;
  }

  setCurrentItem(item: DatabaseItem): void {
    this.current = item;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set the current database by providing a file uri. If the uri's
   * path already exists in the list of recently viewed databases,
   * reuse that item.
   */
  setCurrentUri(dir: vscode.Uri): void {
    let item: DatabaseItem;
    try {
      item = new DatabaseItem(dir);
    }
    catch (e) {
      if (e instanceof NoDatabaseError) {
        vscode.window.showErrorMessage(e.message);
        return;
      }
      else {
        throw e;
      }
    }
    let ix = this.databases.findIndex(it => it.dbUri.fsPath == dir.fsPath);
    if (ix == -1) {
      this.databases.push(item);
      this.setCurrentItem(item);
    }
    else {
      this.setCurrentItem(this.databases[ix]);
    }
  }
}

export class DatabaseManager {
  treeDataProvider: DatabaseTreeDataProvider;
  ctx: ExtensionContext;

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx;
    const db = this.ctx.workspaceState.get<string>(CURRENT_DB);

    let dbi: DatabaseItem | undefined;
    if (db != undefined) {
      try {
        dbi = new DatabaseItem(vscode.Uri.file(db));
      }
      catch (e) {
        if (e instanceof NoDatabaseError) {
          vscode.window.showErrorMessage(e.message);
          dbi = undefined;
          this.ctx.workspaceState.update(CURRENT_DB, undefined);
        }
        else {
          throw e;
        }
      }
    }
    let dbs: DatabaseItem[] = dbi == undefined ? [] : [dbi];
    const treeDataProvider = this.treeDataProvider = new DatabaseTreeDataProvider(ctx, dbs, dbi);
    Window.createTreeView('qlDatabases', { treeDataProvider });
  }

  /**
   * Return the current database directory. If we don't already have a
   * current database, ask the user for one, and return that, or
   * undefined if they cancel.
   */
  async getDatabaseDir(): Promise<vscode.Uri | undefined> {
    const db = this.treeDataProvider.getCurrent();
    const chosen = db == undefined ? (await this.chooseAndSetDatabase()) : db.dbUri;
    return chosen;
  }

  setCurrentItem(db: DatabaseItem) {
    this.treeDataProvider.setCurrentItem(db);
  }

  setCurrentDatabase(db: vscode.Uri) {
    if (db.scheme != 'file')
      throw new Error(`Database uri scheme ${db.scheme} not supported, only file uris are supported.`);
    this.treeDataProvider.setCurrentUri(db);
    this.ctx.workspaceState.update(CURRENT_DB, db.fsPath);
  }

  /**
   * Ask the user for a database directory. Has the side effect of
   * storing that choice in workspace state. Returns the chosen
   * database.
   */
  async chooseAndSetDatabase(): Promise<vscode.Uri | undefined> {
    const chosen = await chooseDatabaseDir(this.ctx);
    if (chosen != undefined)
      this.setCurrentDatabase(chosen);
    return chosen;
  }

  /**
   * Ask the user for a database directory. Has the side effect
   * of storing that choice in workspace state.
   */
  chooseAndSetDatabaseSync() {
    this.chooseAndSetDatabase().catch(e => console.error(e));
  }

}