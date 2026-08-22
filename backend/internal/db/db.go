// Package db opens the MariaDB pool and runs the goose migrations that the
// server applies on every boot.
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/pressly/goose/v3"
)

// Open dials MariaDB and waits for it to answer. A fresh container usually
// needs a few seconds, so the ping is retried rather than failing the boot.
func Open(dsn string) (*sql.DB, error) {
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open mariadb: %w", err)
	}
	pool.SetMaxOpenConns(16)
	pool.SetMaxIdleConns(8)
	pool.SetConnMaxLifetime(30 * time.Minute)

	var pingErr error
	for attempt := 0; attempt < 20; attempt++ {
		if pingErr = pool.Ping(); pingErr == nil {
			return pool, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	pool.Close()
	return nil, fmt.Errorf("ping mariadb: %w", pingErr)
}

// Migrate applies every pending migration in dir. It runs on server start, so
// a deploy is just "restart the process".
func Migrate(pool *sql.DB, dir string) error {
	if err := goose.SetDialect("mysql"); err != nil {
		return fmt.Errorf("goose dialect: %w", err)
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.Up(pool, dir); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}
