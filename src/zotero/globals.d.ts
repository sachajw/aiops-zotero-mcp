/**
 * Types for the parts of Zotero's privileged JavaScript API this plugin uses.
 * Checked against zotero/zotero chrome/content/zotero/xpcom (data/item.js, data/collection.js,
 * data/search.js, attachments.js, cite.js, style.js, server/server.js, recognizeDocument.js,
 * progressQueue.js). Not exhaustive.
 */

declare namespace ZoteroAPI {
  interface Creator {
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }

  interface Item {
    id: number;
    key: string;
    libraryID: number;
    itemType: string;
    deleted: boolean;
    dateAdded: string;
    dateModified: string;
    parentItemID: number | false;
    parentKey: string | false;
    isRegularItem(): boolean;
    isAttachment(): boolean;
    isNote(): boolean;
    isAnnotation(): boolean;
    isPDFAttachment(): boolean;
    isEPUBAttachment(): boolean;
    isTopLevelItem(): boolean;
    getField(field: string, unformatted?: boolean, includeBaseMapped?: boolean): string;
    setField(field: string, value: string | number): boolean;
    getDisplayTitle(): string;
    getCreators(): Creator[];
    setCreators(creators: Creator[]): void;
    getTags(): Array<{ tag: string; type?: number }>;
    addTag(name: string, type?: number): boolean;
    removeTag(name: string): boolean;
    getCollections(): number[];
    addToCollection(collectionIDOrKey: number | string): void;
    removeFromCollection(collectionIDOrKey: number | string): void;
    getAttachments(includeTrashed?: boolean): number[];
    getNotes(includeTrashed?: boolean): number[];
    getNote(): string;
    setNote(text: string): boolean;
    getAnnotations(includeTrashed?: boolean): Item[];
    attachmentFilename: string;
    attachmentContentType: string;
    attachmentLinkMode: number;
    readonly attachmentText: Promise<string | null | undefined>;
    getFilePathAsync(): Promise<string | false>;
    renameAttachmentFile(
      newName: string,
      options?: { overwrite?: boolean; unique?: boolean; updateTitle?: boolean },
    ): Promise<boolean | -1 | -2>;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    saveTx(): Promise<number | boolean>;
    /** Save inside the caller's Zotero.DB.executeTransaction. */
    save(): Promise<number | boolean>;
    toJSON(options?: { mode?: "full" }): Record<string, unknown>;
  }

  interface Collection {
    id: number;
    key: string;
    name: string;
    libraryID: number;
    parentID: number | false;
    parentKey: string | false;
    deleted: boolean;
    getChildCollections(asIDs?: false, includeTrashed?: boolean): Collection[];
    getChildItems(asIDs?: false, includeTrashed?: boolean): Item[];
    saveTx(): Promise<number | boolean>;
  }

  interface Search {
    libraryID: number;
    addCondition(condition: string, operator: string, value?: string | number, required?: boolean): number;
    search(): Promise<number[]>;
  }

  interface Library {
    libraryID: number;
    name: string;
    libraryType: string;
    editable: boolean;
  }

  interface CiteProc {
    free(): void;
  }

  interface Style {
    styleID: string;
    title: string;
    getCiteProc(locale: string, format: "html" | "text", options?: { cache?: boolean }): CiteProc;
  }

  interface ServerRequestData {
    method: string;
    pathname: string;
    headers: Record<string, string | undefined>;
    data: unknown;
  }

  /** [status, contentType or headers, body]; Zotero.Server writes HTTP/1.0 and closes. */
  type ServerResponse = [number, string | Record<string, string>, string?];

  interface EndpointClass {
    new (): {
      supportedMethods: string[];
      supportedDataTypes: string[] | "*";
      init(request: ServerRequestData): Promise<ServerResponse>;
    };
  }
}

declare const Zotero: {
  version: string;
  initializationPromise: Promise<void>;
  debug(message: string, level?: number): void;
  logError(error: unknown): void;
  DB: {
    executeTransaction<T>(fn: () => Promise<T>): Promise<T>;
  };
  Prefs: {
    get(name: string, global?: boolean): unknown;
    set(name: string, value: unknown, global?: boolean): void;
  };
  Libraries: {
    userLibraryID: number;
    get(libraryID: number): ZoteroAPI.Library | false;
    getAll(): ZoteroAPI.Library[];
    hasTrash(libraryID: number): boolean;
  };
  Items: {
    get(ids: number[]): ZoteroAPI.Item[];
    get(id: number): ZoteroAPI.Item | false;
    getByLibraryAndKey(libraryID: number, key: string): ZoteroAPI.Item | false;
    getAsync(ids: number[]): Promise<ZoteroAPI.Item[]>;
    trashTx(ids: number[]): Promise<void>;
  };
  Item: new (itemType?: string) => ZoteroAPI.Item & { libraryID: number; parentKey: string | false };
  ItemTypes: { getID(name: string): number | false; getTypes(): Array<{ id: number; name: string }> };
  ItemFields: {
    getID(field: string): number | false;
    isValidForType(fieldID: number, itemTypeID: number): boolean;
    getItemTypeFields(itemTypeID: number): number[];
    getName(fieldID: number): string;
  };
  CreatorTypes: {
    getTypesForItemType(itemTypeID: number): Array<{ id: number; name: string }>;
  };
  Collections: {
    getByLibraryAndKey(libraryID: number, key: string): ZoteroAPI.Collection | false;
    getByLibrary(libraryID: number, recursive?: boolean, includeTrashed?: boolean): ZoteroAPI.Collection[];
    getByParent(parentCollectionID: number, recursive?: boolean, includeTrashed?: boolean): ZoteroAPI.Collection[];
  };
  Collection: new () => ZoteroAPI.Collection & { libraryID: number; parentKey: string | false; name: string };
  Search: new () => ZoteroAPI.Search;
  Attachments: {
    LINK_MODE_IMPORTED_FILE: number;
    LINK_MODE_IMPORTED_URL: number;
    LINK_MODE_LINKED_FILE: number;
    LINK_MODE_LINKED_URL: number;
    LINK_MODE_EMBEDDED_IMAGE: number;
    importFromFile(options: {
      file: string;
      libraryID?: number;
      parentItemID?: number;
      title?: string;
      collections?: number[];
    }): Promise<ZoteroAPI.Item>;
    linkFromFile(options: {
      file: string;
      parentItemID?: number;
      title?: string;
      collections?: number[];
    }): Promise<ZoteroAPI.Item>;
  };
  /** xpcom/recognizeDocument.js: what Zotero's "Retrieve Metadata for PDF" menu runs. */
  RecognizeDocument: {
    /** Queues the items and resolves when the queue is empty; failures are logged, not thrown. */
    recognizeItems(items: ZoteroAPI.Item[]): Promise<void>;
    canRecognize(item: ZoteroAPI.Item): boolean;
  };
  /** Bluebird, as Zotero ships it. */
  Promise: {
    delay(ms: number): Promise<void>;
  };
  /** xpcom/progressQueue.js; row status 1 = queued, 2 = processing, 3 = failed, 4 = succeeded. */
  ProgressQueues: {
    get(id: string): { getRows(): Array<{ id: number; status: number; message: string }> } | undefined;
  };
  HTTP: {
    browserIsOffline(): boolean;
  };
  Styles: {
    init(): Promise<void>;
    get(id: string): ZoteroAPI.Style | false;
    getVisible(): ZoteroAPI.Style[];
  };
  Cite: {
    makeFormattedBibliographyOrCitationList(
      engine: ZoteroAPI.CiteProc,
      items: ZoteroAPI.Item[],
      format: "html" | "text",
      asCitationList?: boolean,
    ): string;
  };
  Utilities: {
    unescapeHTML(html: string): string;
  };
  Server: {
    Endpoints: Record<string, ZoteroAPI.EndpointClass | undefined>;
    /** Reason phrases for the status line; a missing code is written as "undefined". */
    responseCodes: Record<number, string | undefined>;
  };
};

declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "regular" | "directory" | "other"; size: number }>;
};

declare const PathUtils: {
  isAbsolute(path: string): boolean;
  filename(path: string): string;
};
