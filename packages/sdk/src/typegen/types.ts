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
}
