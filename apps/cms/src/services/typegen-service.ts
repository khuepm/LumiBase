import { collections as collectionsTable, fields, relations, scopeSite } from '@lumibase/database';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { compileSystemFields, type PrimaryKeyType, type RelationType } from './schema-service';

export interface TypegenManifest {
  version: number;
  site: string;
  collections: TypegenCollection[];
}

export interface TypegenCollection {
  name: string;
  primaryKey: string;
  primaryKeyField: string;
  primaryKeyType: PrimaryKeyType;
  fields: TypegenField[];
  relations: TypegenRelation[];
}

export interface TypegenField {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  readonly: boolean;
  generated: boolean;
  system: boolean;
  encrypted: boolean;
  primaryKey: boolean;
  branded?: string;
  kind?: 'm2o' | 'o2m' | 'm2m' | 'm2a';
  target?: string;
  enum?: string[];
}

export interface TypegenRelation {
  field: string;
  kind: RelationType;
  target: string;
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField: string | null;
  junctionCollection: string | null;
}

export class TypegenService {
  constructor(private readonly deps: { db: Database; siteId: string }) {}

  async getManifest(include?: string[], exclude?: string[]): Promise<TypegenManifest> {
    const { db, siteId } = this.deps;

    let collectionRows = await db
      .select()
      .from(collectionsTable)
      .where(scopeSite(collectionsTable.siteId, siteId))
      .orderBy(asc(collectionsTable.name));

    if (include?.length) {
      collectionRows = collectionRows.filter((c) => include.includes(c.name));
    }
    if (exclude?.length) {
      collectionRows = collectionRows.filter((c) => !exclude.includes(c.name));
    }

    const relationRows = await db
      .select()
      .from(relations)
      .where(scopeSite(relations.siteId, siteId));

    const resultCollections: TypegenCollection[] = [];

    for (const coll of collectionRows) {
      const fieldRows = await db
        .select()
        .from(fields)
        .where(eq(fields.collectionId, coll.id))
        .orderBy(asc(fields.sortOrder), asc(fields.name));

      const userFields: TypegenField[] = fieldRows.map((f) => {
        const field: TypegenField = {
          name: f.name,
          type: f.type,
          required: f.required,
          nullable: f.nullable,
          readonly: f.readonly,
          generated: false,
          system: false,
          encrypted: f.encrypted,
          primaryKey: f.name === coll.primaryKeyField,
        };

        // Detect relation fields
        const rel = relationRows.find(
          (r) => r.manyCollection === coll.name && r.manyField === f.name,
        );
        if (rel) {
          field.kind = 'm2o';
          field.target = rel.oneCollection;
          field.branded = `${rel.oneCollection.charAt(0).toUpperCase()}${rel.oneCollection.slice(1)}Id`;
        }

        // Handle branded ID fields
        if (f.type === 'uuid' && f.name === 'id') {
          field.branded = `${coll.name.charAt(0).toUpperCase()}${coll.name.slice(1)}Id`;
        }

        // Extract enum from validation if present
        const validation = f.validation as { rules?: Array<{ rule: string; options?: unknown }> } | undefined;
        if (validation?.rules) {
          const choiceRule = validation.rules.find((r) => r.rule === 'choices');
          if (choiceRule && 'options' in choiceRule && Array.isArray(choiceRule.options)) {
            field.enum = choiceRule.options as string[];
          }
        }

        return field;
      });

      const existingFieldNames = new Set(userFields.map((field) => field.name));
      const systemFields: TypegenField[] = compileSystemFields(coll)
        .filter((field) => !existingFieldNames.has(field.name))
        .map((field) => ({
          name: field.name,
          type: field.type,
          required: !field.nullable,
          nullable: field.nullable,
          readonly: field.readonly,
          generated: field.generated,
          system: true,
          encrypted: false,
          primaryKey: field.name === coll.primaryKeyField,
          branded:
            field.name === coll.primaryKeyField
              ? `${coll.name.charAt(0).toUpperCase()}${coll.name.slice(1)}Id`
              : undefined,
        }));

      const typegenFields = [...systemFields, ...userFields];
      const typegenRelations = relationRows
        .flatMap((relation): TypegenRelation[] => {
          const kind = relation.type as RelationType;
          if (relation.manyCollection === coll.name) {
            return [{
              field: relation.manyField,
              kind,
              target: relation.oneCollection,
              manyCollection: relation.manyCollection,
              manyField: relation.manyField,
              oneCollection: relation.oneCollection,
              oneField: relation.oneField,
              junctionCollection: relation.junctionCollection,
            }];
          }

          if (relation.oneCollection === coll.name) {
            return [{
              field: relation.oneField ?? relation.aliasField ?? relation.manyCollection,
              kind: kind === 'm2m' ? 'm2m' : 'o2m',
              target: relation.manyCollection,
              manyCollection: relation.manyCollection,
              manyField: relation.manyField,
              oneCollection: relation.oneCollection,
              oneField: relation.oneField,
              junctionCollection: relation.junctionCollection,
            }];
          }

          return [];
        })
        .sort((a, b) => a.field.localeCompare(b.field));

      resultCollections.push({
        name: coll.name,
        primaryKey: coll.primaryKeyField,
        primaryKeyField: coll.primaryKeyField,
        primaryKeyType: coll.primaryKeyType as PrimaryKeyType,
        fields: typegenFields,
        relations: typegenRelations,
      });
    }

    return {
      version: 2,
      site: siteId,
      collections: resultCollections,
    };
  }
}
