import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
export const workspaces=pgTable('workspaces',{id:uuid().primaryKey(),name:text().notNull(),currency:text().notNull(),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow()});
export const principals=pgTable('principals',{id:uuid().primaryKey(),name:text().notNull(),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow()});
export const memberships=pgTable('memberships',{workspaceId:uuid('workspace_id').notNull().references(()=>workspaces.id),principalId:uuid('principal_id').notNull().references(()=>principals.id),role:text().notNull()},t=>[primaryKey({columns:[t.workspaceId,t.principalId]})]);
// Financial constraints and append-only evidence are versioned in migrations/001_initial.sql.
// SQL repositories handle locking and set-based writes; Drizzle handles typed membership reads.
