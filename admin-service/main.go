package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	_ "github.com/lib/pq"
)

var db *sql.DB
var jwtSecret []byte

type Vendor struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Approved bool   `json:"approved"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
	Name  string `json:"name"`
}

type Report struct {
	ID             string    `json:"id"`
	ReporterID     string    `json:"reporter_id"`
	ReporterName   string    `json:"reporter_name"`
	ReportedUserID string    `json:"reported_user_id"`
	ReportedName   string    `json:"reported_name"`
	Reason         string    `json:"reason"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
}

type BlockedUser struct {
	ID           string     `json:"id"`
	Email        string     `json:"email"`
	Name         string     `json:"name"`
	BlockedUntil *time.Time `json:"blocked_until"`
}

func main() {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		log.Fatal("FATAL: JWT_SECRET environment variable is missing")
	}
	jwtSecret = []byte(secret)

	var connStr string
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		connStr = dbURL
		log.Println("Using DATABASE_URL")
	} else {
		dbHost := getEnv("DB_HOST", "db")
		dbUser := getEnv("DB_USER", "postgres")
		dbPass := getEnv("DB_PASSWORD", "postgres")
		dbName := getEnv("DB_NAME", "wedding")
		dbSSL := getEnv("DB_SSLMODE", "disable")

		u := &url.URL{
			Scheme:   "postgres",
			User:     url.UserPassword(dbUser, dbPass),
			Host:     dbHost,
			Path:     dbName,
			RawQuery: fmt.Sprintf("sslmode=%s", dbSSL),
		}
		connStr = u.String()
		log.Println("Using individual DB env vars")
	}

	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("Database connection error: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		log.Fatalf("Database ping failed: %v", err)
	}
	log.Println("Connected to database")

	r := gin.Default()

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "OK", "service": "admin-service"})
	})

	admin := r.Group("/api/admin")
	admin.Use(authRequired())
	{
		admin.GET("/vendors", listVendors)
		admin.PUT("/vendors/:id/approve", approveVendor)
		admin.GET("/users", listUsers)
		admin.GET("/reports", listReports)
		admin.POST("/block-user", blockUser)
		admin.POST("/unblock-user", unblockUser)
		admin.GET("/blocked-users", listBlockedUsers)
	}

	port := getEnv("PORT", "8082")
	log.Printf("Admin service starting on port %s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

// authRequired validates JWT, checks admin role, and verifies expiration using standard library method.
func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || len(authHeader) < 7 || !strings.EqualFold(authHeader[:7], "bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or invalid token"})
			return
		}
		tokenStr := authHeader[7:]

		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok || t.Method.Alg() != "HS256" {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return jwtSecret, nil
		})

		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
			return
		}

		// ✅ Correct expiration check using standard library method
		expTime, err := claims.GetExpirationTime()
		if err != nil || expTime == nil || time.Now().After(expTime.Time) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token expired or missing exp"})
			return
		}

		role, ok := claims["role"].(string)
		if !ok || role != "admin" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin access required"})
			return
		}

		userID, ok := claims["user_id"].(string)
		if !ok || userID == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid user_id claim"})
			return
		}

		c.Set("user_id", userID)
		c.Next()
	}
}

func listVendors(c *gin.Context) {
	limit, offset := getPagination(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(id, ''), COALESCE(name, ''), COALESCE(category, ''), COALESCE(approved, false)
		FROM vendors
		ORDER BY name, id
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		log.Printf("listVendors query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database query failed"})
		return
	}
	defer rows.Close()

	vendors := make([]Vendor, 0)
	for rows.Next() {
		var v Vendor
		if err := rows.Scan(&v.ID, &v.Name, &v.Category, &v.Approved); err != nil {
			log.Printf("scan error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading vendor rows"})
			return
		}
		vendors = append(vendors, v)
	}
	if err := rows.Err(); err != nil {
		log.Printf("rows error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading vendor data"})
		return
	}
	c.JSON(http.StatusOK, vendors)
}

func approveVendor(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Approved bool `json:"approved"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	res, err := db.ExecContext(ctx, "UPDATE vendors SET approved = $1 WHERE id = $2", body.Approved, id)
	if err != nil {
		log.Printf("approveVendor error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update vendor"})
		return
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "vendor not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "updated"})
}

func listUsers(c *gin.Context) {
	limit, offset := getPagination(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(id, ''), COALESCE(email, ''), COALESCE(role, ''), COALESCE(name, '')
		FROM users
		ORDER BY email, id
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		log.Printf("listUsers query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database query failed"})
		return
	}
	defer rows.Close()

	users := make([]User, 0)
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Role, &u.Name); err != nil {
			log.Printf("scan error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading user rows"})
			return
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		log.Printf("rows error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading user data"})
		return
	}
	c.JSON(http.StatusOK, users)
}

func listReports(c *gin.Context) {
	limit, offset := getPagination(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT
			COALESCE(r.id, ''),
			COALESCE(r.reporter_id, ''),
			COALESCE(u1.name, 'Deleted User'),
			COALESCE(r.reported_user_id, ''),
			COALESCE(u2.name, 'Deleted User'),
			COALESCE(r.reason, ''),
			COALESCE(r.status, ''),
			COALESCE(r.created_at, NOW())
		FROM reports r
		LEFT JOIN users u1 ON r.reporter_id = u1.id
		LEFT JOIN users u2 ON r.reported_user_id = u2.id
		ORDER BY r.created_at DESC, r.id DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		log.Printf("listReports query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database query failed"})
		return
	}
	defer rows.Close()

	reports := make([]Report, 0)
	for rows.Next() {
		var r Report
		if err := rows.Scan(
			&r.ID,
			&r.ReporterID,
			&r.ReporterName,
			&r.ReportedUserID,
			&r.ReportedName,
			&r.Reason,
			&r.Status,
			&r.CreatedAt,
		); err != nil {
			log.Printf("scan error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading report rows"})
			return
		}
		reports = append(reports, r)
	}
	if err := rows.Err(); err != nil {
		log.Printf("rows error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading report data"})
		return
	}
	c.JSON(http.StatusOK, reports)
}

func blockUser(c *gin.Context) {
	var body struct {
		UserID string `json:"userId"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.UserID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid userId required"})
		return
	}

	adminID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
		return
	}
	if adminID.(string) == body.UserID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot block yourself"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	res, err := db.ExecContext(ctx,
		"UPDATE users SET blocked_until = NOW() + INTERVAL '1 year' WHERE id = $1",
		body.UserID,
	)
	if err != nil {
		log.Printf("blockUser error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block user"})
		return
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "user blocked"})
}

func unblockUser(c *gin.Context) {
	var body struct {
		UserID string `json:"userId"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.UserID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid userId required"})
		return
	}

	// ✅ Prevent admin from unblocking themselves
	adminID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
		return
	}
	if adminID.(string) == body.UserID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot unblock yourself"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	res, err := db.ExecContext(ctx,
		"UPDATE users SET blocked_until = NULL WHERE id = $1",
		body.UserID,
	)
	if err != nil {
		log.Printf("unblockUser error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unblock user"})
		return
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "user unblocked"})
}

func listBlockedUsers(c *gin.Context) {
	limit, offset := getPagination(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(id, ''), COALESCE(email, ''), COALESCE(name, ''), blocked_until
		FROM users
		WHERE blocked_until IS NOT NULL AND blocked_until > NOW()
		ORDER BY blocked_until DESC, id DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		log.Printf("listBlockedUsers query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database query failed"})
		return
	}
	defer rows.Close()

	users := make([]BlockedUser, 0)
	for rows.Next() {
		var u BlockedUser
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.BlockedUntil); err != nil {
			log.Printf("scan error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading blocked user rows"})
			return
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		log.Printf("rows error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error reading blocked users"})
		return
	}
	c.JSON(http.StatusOK, users)
}

func getPagination(c *gin.Context) (int, int) {
	limit := 20
	offset := 0
	if l := c.Query("limit"); l != "" {
		if val, err := strconv.Atoi(l); err == nil && val > 0 {
			if val > 100 {
				val = 100
			}
			limit = val
		}
	}
	if o := c.Query("offset"); o != "" {
		if val, err := strconv.Atoi(o); err == nil && val >= 0 {
			offset = val
		}
	}
	return limit, offset
}
