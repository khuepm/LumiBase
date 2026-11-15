export interface TypegenManifest {
  version: number;
  site: string;
  collections: TypegenCollection[];
}

export interface TypegenCollection {
  name: string;
  primaryKey: string;
  primaryKeyField?: string;
  primaryKeyType?: 'nanoid' | 'uuid' | 'integer' | 'bigInteger' | 'string';
  fields: TypegenField[];
  relations?: TypegenRelation[];
}

export interface TypegenField {
  name: string;
  type: string;
  /**
   * Studio interface id (`translatable-text`, `file`, `files`, …). Optional so
   * manifests from older servers still type-check; generators use it to tell a
   * per-locale map or a file reference from a plain scalar.
   */
  interface?: string;
  required: boolean;
  nullable: boolean;
  readonly?: boolean;
  generated?: boolean;
  system?: boolean;
  encrypted?: boolean;
  primaryKey?: boolean;
  branded?: string;
  kind?: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  target?: string;
  enum?: string[];
}

export interface TypegenRelation {
  field: string;
  kind: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  target: string;
  manyCollection?: string;
  manyField?: string;
  oneCollection?: string;
  oneField?: string | null;
  junctionCollection?: string | null;
  /**
   * The relation row's own `type`. `kind` is the direction seen from this
   * collection (an m2o row reads as `o2m` from its one side); the GraphQL SDL
   * target needs the stored type to mirror which nested fields the server adds.
   */
  relationType?: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  /** Field name the server's GraphQL expansion uses for this relation. */
  alias?: string;
}
