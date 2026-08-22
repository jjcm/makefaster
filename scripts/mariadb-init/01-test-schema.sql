-- The schema the MariaDB-backed Go tests drop and re-migrate. Created here so
-- `docker compose up -d` is all the setup `go test ./...` needs.
CREATE DATABASE IF NOT EXISTS makefaster_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
