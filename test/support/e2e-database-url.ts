// The e2e suite never reads a developer's .env: the database it uses is
// either the one CI hands over in E2E_DATABASE_URL or, by default, a
// `tshirt_store_test` database on the Postgres that docker-compose.yml
// already runs — with the credentials that file declares for that local
// container, which reach no real environment.
export const DEFAULT_E2E_DATABASE_URL =
  'postgresql://tshirt:tshirt@localhost:5433/tshirt_store_test?schema=public';

export function e2eDatabaseUrl(): string {
  return process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
}
