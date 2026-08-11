// Copyright (c) 2026, Oracle and/or its affiliates.
import { oracleConstraintName } from "../utils.js";

export interface OracleStoreMigrationTables {
  store: string;
  storeVectors: string;
  storeMigrations: string;
  vectorMigrations: string;
}

export const getCreateStoreMigrationTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.storeMigrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.storeMigrations,
    "PK"
  )} PRIMARY KEY (v)
)`;

export const getCreateStoreTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.store} (
  prefix VARCHAR2(4000) NOT NULL,
  key VARCHAR2(4000) NOT NULL,
  value JSON NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  ttl_minutes NUMBER DEFAULT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.store,
    "PK"
  )} PRIMARY KEY (prefix, key)
)`;

export const getCreateStoreVectorTableSQL = (
  tables: OracleStoreMigrationTables,
  dims: number
): string => `CREATE TABLE ${tables.storeVectors} (
  prefix VARCHAR2(2000) NOT NULL,
  key VARCHAR2(2000) NOT NULL,
  field_name VARCHAR2(2000) NOT NULL,
  embedding VECTOR(${dims}),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ${oracleConstraintName(tables.storeVectors, "PK")} PRIMARY KEY (
    prefix,
    key,
    field_name
  ),
  CONSTRAINT ${oracleConstraintName(tables.storeVectors, "FK")} FOREIGN KEY (
    prefix,
    key
  ) REFERENCES ${tables.store}(prefix, key) ON DELETE CASCADE
)`;

export const getCreateVectorMigrationTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.vectorMigrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.vectorMigrations,
    "PK"
  )} PRIMARY KEY (v)
)`;
