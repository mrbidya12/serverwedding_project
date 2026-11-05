package main

import (
	"context"
	cryptorand "crypto/rand"
	"database/sql"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/smtp"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"golang.org/x/crypto/bcrypt"
)

var (
	db        *sql.DB
	jwtSecret []byte
	dummyHash []byte

	loginLimiter      = newIPRateLimiter(30, time.Minute)
	registerLimiter   = newIPRateLimiter(10, time.Minute)
	forgotPassLimiter = newIPRateLimiter(5, time.Minute)
	resetPassLimiter  = newIPRateLimiter(10, time.Minute)
)

const (
	maxUploadSize = 10 << 20
	otpExpiry     = 2 * time.Minute
)

var profileUploadDir = getEnv("UPLOAD_DIR", "/app/uploads/profile")

// ---------- Data types ----------
type BlockCacheEntry struct {
	BlockedUntil time.Time
	Reason       string
	IsBlocked    bool
	CachedAt     time.Time
}

var (
	blockCache sync.Map
	cacheTTL   = 2 * time.Minute
)

type User struct {
	ID             string     `json:"id"`
	Email          string     `json:"email"`
	Phone          string     `json:"phone"`
	Password       string     `json:"-"`
	Role           string     `json:"role"`
	Name           string     `json:"name"`
	Country        string     `json:"country"`
	State          string     `json:"state"`
	City           string     `json:"city"`
	Block          string     `json:"block"`
	Pincode        string     `json:"pincode"`
	ProfilePicture string     `json:"profile_picture,omitempty"`
	PublicKey      string     `json:"public_key,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	BlockedUntil   *time.Time `json:"blocked_until,omitempty"`
	BlockedReason  *string    `json:"blocked_reason,omitempty"`
}

type ReviewResponse struct {
	ID         string    `json:"id"`
	VendorID   string    `json:"vendor_id"`
	VendorName string    `json:"vendor_name"`
	Rating     int       `json:"rating"`
	Comment    string    `json:"comment"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// ---------- Custom IP Rate Limiter ----------
type ipRateLimiter struct {
	mu     sync.Mutex
	ips    map[string]*ipEntry
	limit  int
	window time.Duration
}

type ipEntry struct {
	count     int
	resetTime time.Time
}

func newIPRateLimiter(limit int, window time.Duration) *ipRateLimiter {
	return &ipRateLimiter{
		ips:    make(map[string]*ipEntry),
		limit:  limit,
		window: window,
	}
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry, exists := l.ips[ip]
	if !exists || now.After(entry.resetTime) {
		entry = &ipEntry{count: 1, resetTime: now.Add(l.window)}
		l.ips[ip] = entry
		return true
	}
	if entry.count < l.limit {
		entry.count++
		return true
	}
	return false
}

func (l *ipRateLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		l.mu.Lock()
		now := time.Now()
		for ip, entry := range l.ips {
			if now.After(entry.resetTime.Add(l.window)) {
				delete(l.ips, ip)
			}
		}
		l.mu.Unlock()
	}
}

// ---------- Async job queue ----------
type asyncJob struct{ fn func(context.Context) }

var jobQueue = make(chan asyncJob, 1000)

func init() {
	var err error
	dummyHash, err = bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing"), 12)
	if err != nil {
		log.Fatalf("Failed to precompute dummy hash: %v", err)
	}

	for i := 0; i < 5; i++ {
		go func() {
			for job := range jobQueue {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				job.fn(ctx)
				cancel()
			}
		}()
	}
	go loginLimiter.cleanup()
	go registerLimiter.cleanup()
	go forgotPassLimiter.cleanup()
	go resetPassLimiter.cleanup()
	go otpRateLimitCleanup()
	go otpAttemptsCleanup()
}

func scheduleAsync(fn func(context.Context)) {
	select {
	case jobQueue <- asyncJob{fn: fn}:
	default:
		log.Printf("Async job queue full, dropping task")
	}
}

// ---------- Main ----------
func main() {
	secretEnv := os.Getenv("JWT_SECRET")
	if secretEnv == "" {
		log.Fatal("FATAL: JWT_SECRET environment variable is required")
	}
	jwtSecret = []byte(secretEnv)

	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbUser := getEnv("DB_USER", "postgres")
	dbPass := getEnv("DB_PASSWORD", "postgres")
	dbName := getEnv("DB_NAME", "wedding")

	connStr := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		dbHost, dbPort, dbUser, dbPass, dbName)

	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal("Failed to open DB connection:", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(100)
	db.SetMaxIdleConns(25)
	db.SetConnMaxLifetime(15 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		log.Fatal("Database ping failed:", err)
	}
	log.Println("✅ Database connected successfully")

	if os.Getenv("GIN_MODE") == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	go cacheCleanup()

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
		log.Fatalf("Failed to set trusted proxies: %v", err)
	}

	r.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/uploads/") {
			c.Header("X-Content-Type-Options", "nosniff")
		}
		c.Next()
	})

	r.Static("/uploads", "/app/uploads")

	r.GET("/health", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unhealthy", "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "auth-service"})
	})

	r.GET("/api/users/ping", func(c *gin.Context) {
		c.String(http.StatusOK, "pong")
	})

	r.POST("/api/users/register", rateLimitMiddleware(registerLimiter), register)
	r.POST("/api/users/login", rateLimitMiddleware(loginLimiter), login)
	r.POST("/api/users/send-otp", sendOTP)
	r.POST("/api/users/verify-otp", verifyOTP)
	r.POST("/api/users/forgot-password", rateLimitMiddleware(forgotPassLimiter), forgotPassword)
	r.POST("/api/users/reset-password", rateLimitMiddleware(resetPassLimiter), resetPassword)

	protected := r.Group("/api/users")
	protected.Use(authRequired())
	{
		protected.GET("/validate", validateToken)
		protected.GET("/profile", profile)
		protected.POST("/profile/picture", uploadProfilePicture)
		protected.PUT("/public-key", updatePublicKey)
		protected.GET("/:userId/public-key", getPublicKey)
	}

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	log.Println("🚀 Auth service running on port 8080")
	log.Fatal(srv.ListenAndServe())
}

// ---------- Middleware ----------
func rateLimitMiddleware(limiter *ipRateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if !limiter.allow(ip) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many requests"})
			return
		}
		c.Next()
	}
}

// ---------- Cache Cleanup ----------
func cacheCleanup() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		blockCache.Range(func(key, value interface{}) bool {
			entry, ok := value.(BlockCacheEntry)
			if !ok {
				return true
			}
			if entry.IsBlocked && entry.BlockedUntil.After(now) {
				return true
			}
			if time.Since(entry.CachedAt) >= cacheTTL {
				blockCache.Delete(key)
			}
			return true
		})
	}
}

// ---------- OTP Generation ----------
func generateOTP() (string, error) {
	for i := 0; i < 3; i++ {
		n, err := cryptorand.Int(cryptorand.Reader, big.NewInt(1000000))
		if err == nil {
			return fmt.Sprintf("%06d", n.Int64()), nil
		}
		time.Sleep(time.Microsecond)
	}
	return "", fmt.Errorf("failed to generate secure OTP after 3 attempts")
}

// ---------- Register ----------
func register(c *gin.Context) {
	var input struct {
		Email             string   `json:"email" binding:"required,email"`
		Password          string   `json:"password" binding:"required,min=6,max=72"`
		Name              string   `json:"name" binding:"required"`
		Phone             string   `json:"phone" binding:"required"`
		Role              string   `json:"role"`
		Country           string   `json:"country" binding:"required"`
		State             string   `json:"state" binding:"required"`
		City              string   `json:"city" binding:"required"`
		Block             string   `json:"block" binding:"required"`
		Pincode           string   `json:"pincode" binding:"required"`
		YearsOfExperience *int     `json:"yearsOfExperience"`
		MinPrice          *float64 `json:"minPrice"`
		MaxPrice          *float64 `json:"maxPrice"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	input.Role = strings.ToLower(input.Role)
	if input.Role == "" {
		input.Role = "client"
	}
	if input.Role != "client" && input.Role != "vendor" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be client or vendor"})
		return
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(input.Password), 12)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to process password"})
		return
	}
	userID := uuid.New().String()

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transaction start failed"})
		return
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
        INSERT INTO users(id, email, password_hash, role, name, phone, country, state, city, block, pincode, email_verified)
        VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
		userID, strings.ToLower(input.Email), string(hashed), input.Role, input.Name, input.Phone,
		input.Country, input.State, input.City, input.Block, input.Pincode)
	if err != nil {
		log.Printf("User insert failed: %v", err)
		c.JSON(http.StatusConflict, gin.H{"error": "email already registered or invalid input"})
		return
	}

	if input.Role == "vendor" {
		vendorID := uuid.New().String()
		category := "OTHER"
		_, err = tx.ExecContext(ctx, `
            INSERT INTO vendors (
                id, owner_id, name, category, years_of_experience,
                min_price, max_price, phone, country, state, city, block, pincode,
                approved, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
			vendorID, userID, input.Name, category,
			nullIfZero(input.YearsOfExperience),
			nullIfZeroFloat(input.MinPrice),
			nullIfZeroFloat(input.MaxPrice),
			input.Phone,
			input.Country, input.State, input.City, input.Block, input.Pincode,
			false, time.Now(),
		)
		if err != nil {
			log.Printf("Vendor profile insert failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create vendor entity"})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to commit transaction"})
		return
	}

	// Send OTP to verify email
	otp, err := generateOTP()
	if err != nil {
		log.Printf("Failed to generate OTP for user %s: %v", userID, err)
		c.JSON(http.StatusCreated, gin.H{"message": "User registered successfully, but OTP generation failed. Please request OTP manually."})
		return
	}
	expiresAt := time.Now().Add(otpExpiry)
	_, err = db.ExecContext(ctx, `
        INSERT INTO otp_attempts (identifier, otp, expires_at, action, verified)
        VALUES ($1, $2, $3, 'verify', false)`,
		strings.ToLower(input.Email), otp, expiresAt)
	if err != nil {
		log.Printf("Failed to store OTP for user %s: %v", userID, err)
		c.JSON(http.StatusCreated, gin.H{"message": "User registered successfully, but OTP storage failed. Please request OTP manually."})
		return
	}
	scheduleAsync(func(ctx context.Context) {
		sendEmailOTP(ctx, input.Email, otp)
	})

	c.JSON(http.StatusCreated, gin.H{"message": "User registered successfully. Please verify your email with the OTP sent.", "id": userID})
}

// ---------- Login ----------
func login(c *gin.Context) {
	var input struct {
		Email    string `json:"email" binding:"required,email"`
		Password string `json:"password" binding:"required,max=72"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.Password = strings.TrimSpace(input.Password)

	var user User
	var profilePicStr sql.NullString
	var blockedUntil sql.NullTime
	var blockedReason sql.NullString
	var storedHash string
	var emailVerified bool

	row := db.QueryRowContext(c.Request.Context(), `
        SELECT id, email, password_hash, role, name, phone, country, state, city, block, pincode, profile_picture, blocked_until, blocked_reason, email_verified
        FROM users WHERE email=$1`, input.Email)

	err := row.Scan(&user.ID, &user.Email, &storedHash, &user.Role, &user.Name,
		&user.Phone, &user.Country, &user.State, &user.City, &user.Block, &user.Pincode,
		&profilePicStr, &blockedUntil, &blockedReason, &emailVerified)

	if err != nil {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(input.Password))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if !emailVerified {
		c.JSON(http.StatusForbidden, gin.H{"error": "email not verified, please verify with OTP first"})
		return
	}

	if profilePicStr.Valid {
		user.ProfilePicture = profilePicStr.String
	}
	if blockedUntil.Valid && blockedUntil.Time.After(time.Now()) {
		c.JSON(http.StatusForbidden, gin.H{
			"error":         "Your account is temporarily blocked",
			"blocked_until": blockedUntil.Time.Format(time.RFC3339),
			"reason":        blockedReason.String,
		})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(input.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_id": user.ID,
		"email":   user.Email,
		"role":    user.Role,
		"exp":     time.Now().Add(72 * time.Hour).Unix(),
	})
	tokenString, err := token.SignedString(jwtSecret)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"token": tokenString,
		"user": gin.H{
			"id":              user.ID,
			"email":           user.Email,
			"role":            user.Role,
			"name":            user.Name,
			"phone":           user.Phone,
			"country":         user.Country,
			"state":           user.State,
			"city":            user.City,
			"block":           user.Block,
			"pincode":         user.Pincode,
			"profile_picture": user.ProfilePicture,
		},
	})
}

// ---------- Profile ----------
func profile(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var user User
	var profilePicStr sql.NullString
	row := db.QueryRowContext(c.Request.Context(), `
        SELECT id, email, role, name, phone, country, state, city, block, pincode, profile_picture, created_at
        FROM users WHERE id=$1`, userID)
	err := row.Scan(&user.ID, &user.Email, &user.Role, &user.Name,
		&user.Phone, &user.Country, &user.State, &user.City, &user.Block, &user.Pincode,
		&profilePicStr, &user.CreatedAt)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if profilePicStr.Valid {
		user.ProfilePicture = profilePicStr.String
	}

	// Fetch reviews – safe query without deleted_at
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()

	reviewsQuery := `
        SELECT
            r.id,
            r.vendor_id,
            v.name AS vendor_name,
            r.rating,
            r.comment,
            r.created_at,
            r.updated_at
        FROM reviews r
        JOIN vendors v ON r.vendor_id = v.id
        WHERE r.client_id = $1
        ORDER BY r.created_at DESC
        LIMIT 20
    `
	rows, err := db.QueryContext(ctx, reviewsQuery, userID)
	if err != nil {
		log.Printf("Failed to fetch reviews: %v", err)
		c.JSON(http.StatusOK, gin.H{
			"user":    user,
			"reviews": []ReviewResponse{},
		})
		return
	}
	defer rows.Close()

	reviews := make([]ReviewResponse, 0)
	for rows.Next() {
		var rev ReviewResponse
		err := rows.Scan(
			&rev.ID,
			&rev.VendorID,
			&rev.VendorName,
			&rev.Rating,
			&rev.Comment,
			&rev.CreatedAt,
			&rev.UpdatedAt,
		)
		if err != nil {
			log.Printf("Scan review row failed: %v", err)
			continue
		}
		reviews = append(reviews, rev)
	}
	if err = rows.Err(); err != nil {
		log.Printf("Rows iteration error: %v", err)
	}
	c.JSON(http.StatusOK, gin.H{
		"user":    user,
		"reviews": reviews,
	})
}

// ---------- Validate Token ----------
func validateToken(c *gin.Context) {
	userID, _ := c.Get("user_id")
	role, _ := c.Get("role")
	c.JSON(http.StatusOK, gin.H{"user_id": userID, "role": role, "valid": true})
}

// ---------- Auth Middleware ----------
func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or invalid authorization header"})
			return
		}
		tokenStr := authHeader[7:]
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return jwtSecret, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token claims"})
			return
		}
		userID, ok := claims["user_id"].(string)
		if !ok || userID == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid user ID claim"})
			return
		}
		role, ok := claims["role"].(string)
		if !ok || role == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid role claim"})
			return
		}

		if val, found := blockCache.Load(userID); found {
			entry := val.(BlockCacheEntry)
			if time.Since(entry.CachedAt) < cacheTTL {
				if !entry.IsBlocked {
					c.Set("user_id", userID)
					c.Set("role", role)
					c.Next()
					return
				}
				if entry.IsBlocked && entry.BlockedUntil.After(time.Now()) {
					c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
						"error":         "Your account is temporarily blocked",
						"blocked_until": entry.BlockedUntil.Format(time.RFC3339),
						"reason":        entry.Reason,
					})
					return
				}
				blockCache.Delete(userID)
			} else {
				blockCache.Delete(userID)
			}
		}

		var bUntil sql.NullTime
		var bReason sql.NullString
		err = db.QueryRowContext(c.Request.Context(),
			"SELECT blocked_until, blocked_reason FROM users WHERE id = $1", userID).Scan(&bUntil, &bReason)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
			return
		}
		now := time.Now()
		if bUntil.Valid && bUntil.Time.After(now) {
			blockCache.Store(userID, BlockCacheEntry{
				BlockedUntil: bUntil.Time,
				Reason:       bReason.String,
				IsBlocked:    true,
				CachedAt:     now,
			})
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":         "Your account is temporarily blocked",
				"blocked_until": bUntil.Time.Format(time.RFC3339),
				"reason":        bReason.String,
			})
			return
		}
		blockCache.Store(userID, BlockCacheEntry{IsBlocked: false, CachedAt: now})
		c.Set("user_id", userID)
		c.Set("role", role)
		c.Next()
	}
}

// ---------- Upload Profile Picture ----------
func uploadProfilePicture(c *gin.Context) {
	if err := c.Request.ParseMultipartForm(maxUploadSize); err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file too large (max 10 MB)"})
		return
	}
	userIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	userID, ok := userIDRaw.(string)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid user ID type"})
		return
	}
	file, _, err := c.Request.FormFile("picture")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing picture file"})
		return
	}
	defer file.Close()
	header := make([]byte, 512)
	n, err := io.ReadFull(file, header)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read file header"})
		return
	}
	header = header[:n]
	mimeType := http.DetectContentType(header)
	if !strings.HasPrefix(mimeType, "image/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is not a valid image"})
		return
	}
	var ext string
	switch mimeType {
	case "image/jpeg":
		ext = ".jpg"
	case "image/png":
		ext = ".png"
	case "image/webp":
		ext = ".webp"
	case "image/gif":
		ext = ".gif"
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported image format"})
		return
	}
	if err := os.MkdirAll(profileUploadDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create upload directory"})
		return
	}
	safeFilename := filepath.Base(userID + "_" + strconv.FormatInt(time.Now().UnixNano(), 10) + ext)
	dst := filepath.Clean(filepath.Join(profileUploadDir, safeFilename))
	rel, err := filepath.Rel(profileUploadDir, dst)
	if err != nil || strings.HasPrefix(rel, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file path"})
		return
	}
	out, err := os.Create(dst)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create file"})
		return
	}
	var success bool
	defer func() {
		if out != nil {
			out.Close()
		}
		if !success {
			os.Remove(dst)
		}
	}()
	if _, err := out.Write(header); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}
	relPath := "/uploads/profile/" + safeFilename
	_, err = db.ExecContext(c.Request.Context(), "UPDATE users SET profile_picture = $1 WHERE id = $2", relPath, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to record profile picture path"})
		return
	}
	success = true
	c.JSON(http.StatusOK, gin.H{"profile_picture": relPath})
}

// ---------- OTP Rate Limiting ----------
type otpRateLimit struct {
	mu           sync.Mutex
	failCount    int
	blockedUntil time.Time
	lastAccess   time.Time
}

var otpRateLimitMap sync.Map

func getOTPRateLimit(identifier string) *otpRateLimit {
	entry := &otpRateLimit{lastAccess: time.Now()}
	actual, _ := otpRateLimitMap.LoadOrStore(identifier, entry)
	res := actual.(*otpRateLimit)
	res.mu.Lock()
	res.lastAccess = time.Now()
	res.mu.Unlock()
	return res
}

func otpRateLimitCleanup() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		otpRateLimitMap.Range(func(key, value interface{}) bool {
			entry := value.(*otpRateLimit)
			entry.mu.Lock()
			expired := now.Sub(entry.lastAccess) > 30*time.Minute
			entry.mu.Unlock()
			if expired {
				otpRateLimitMap.Delete(key)
			}
			return true
		})
	}
}

func otpAttemptsCleanup() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Minute)
		_, err := db.ExecContext(ctx, "DELETE FROM otp_attempts WHERE expires_at < NOW() - INTERVAL '1 day'")
		if err != nil {
			log.Printf("OTP cleanup failed: %v", err)
		}
		cancel()
	}
}

// ---------- Send OTP ----------
func sendOTP(c *gin.Context) {
	var input struct {
		Email string `json:"email" binding:"omitempty,email"`
		Phone string `json:"phone"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if input.Email == "" && input.Phone == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email or phone required"})
		return
	}
	otp, err := generateOTP()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate OTP"})
		return
	}
	expiresAt := time.Now().Add(otpExpiry)
	ctx := c.Request.Context()

	if input.Email != "" {
		email := strings.ToLower(strings.TrimSpace(input.Email))
		_, err := db.ExecContext(ctx, `
			INSERT INTO otp_attempts (identifier, otp, expires_at, action, verified)
			VALUES ($1, $2, $3, 'verify', false)`,
			email, otp, expiresAt)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store OTP for email"})
			return
		}
		scheduleAsync(func(ctx context.Context) {
			sendEmailOTP(ctx, email, otp)
		})
	}
	if input.Phone != "" {
		phone := strings.TrimSpace(input.Phone)
		_, err := db.ExecContext(ctx, `
			INSERT INTO otp_attempts (identifier, otp, expires_at, action, verified)
			VALUES ($1, $2, $3, 'verify', false)`,
			phone, otp, expiresAt)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store OTP for phone"})
			return
		}
		scheduleAsync(func(ctx context.Context) {
			sendSMSOTP(ctx, phone, otp)
		})
	}
	c.JSON(http.StatusOK, gin.H{"message": "OTP sent successfully"})
}

// ---------- Verify OTP ----------
func verifyOTP(c *gin.Context) {
	var input struct {
		Identifier string `json:"identifier" binding:"required"`
		OTP        string `json:"otp" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	identifier := strings.ToLower(strings.TrimSpace(input.Identifier))
	isEmail := strings.Contains(identifier, "@")
	if !isEmail {
		phoneDigits := strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, identifier)
		if len(phoneDigits) < 7 || len(phoneDigits) > 15 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid phone number format"})
			return
		}
	}

	rate := getOTPRateLimit(identifier)
	rate.mu.Lock()
	defer rate.mu.Unlock()

	now := time.Now()
	if rate.blockedUntil.After(now) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error": fmt.Sprintf("too many failed attempts, try again after %s", rate.blockedUntil.Format(time.RFC3339)),
		})
		return
	}
	if rate.failCount >= 5 {
		rate.blockedUntil = now.Add(5 * time.Minute)
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many failed attempts, try again in 5 minutes"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transaction failed"})
		return
	}
	defer func() { _ = tx.Rollback() }()

	var recordID string
	var expiresAt time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT id, expires_at FROM otp_attempts
		WHERE identifier = $1 AND otp = $2 AND action = 'verify' AND verified = false
		ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
		identifier, input.OTP).Scan(&recordID, &expiresAt)
	if err != nil {
		rate.failCount++
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or expired OTP"})
		return
	}
	if time.Now().After(expiresAt) {
		rate.failCount++
		c.JSON(http.StatusBadRequest, gin.H{"error": "OTP expired"})
		return
	}

	rate.failCount = 0
	rate.blockedUntil = time.Time{}

	_, err = tx.ExecContext(ctx, `UPDATE otp_attempts SET verified = true WHERE id = $1`, recordID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify OTP"})
		return
	}

	var res sql.Result
	if isEmail {
		res, err = tx.ExecContext(ctx, `UPDATE users SET email_verified = true WHERE email = $1`, identifier)
	} else {
		res, err = tx.ExecContext(ctx, `UPDATE users SET phone_verified = true WHERE phone = $1`, identifier)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "no user found with this identifier"})
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Commit failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to complete verification"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "OTP verified successfully"})
}

// ---------- Forgot Password ----------
func forgotPassword(c *gin.Context) {
	var input struct {
		Email string `json:"email" binding:"required,email"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))

	otp, err := generateOTP()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate OTP"})
		return
	}

	var exists bool
	err = db.QueryRowContext(c.Request.Context(), `
        SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND email_verified = true)`, email).Scan(&exists)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}

	if exists {
		expiresAt := time.Now().Add(otpExpiry)
		_, err = db.ExecContext(c.Request.Context(), `
			INSERT INTO otp_attempts (identifier, otp, expires_at, action, verified)
			VALUES ($1, $2, $3, 'reset_password', false)`,
			email, otp, expiresAt)
		if err != nil {
			log.Printf("Failed to insert reset OTP for %s: %v", email, err)
			c.JSON(http.StatusOK, gin.H{"message": "If this email is registered, a password reset OTP has been sent."})
			return
		}
		scheduleAsync(func(ctx context.Context) {
			sendEmailOTP(ctx, email, otp)
		})
	}

	c.JSON(http.StatusOK, gin.H{"message": "If this email is registered, a password reset OTP has been sent."})
}

// ---------- Reset Password ----------
func resetPassword(c *gin.Context) {
	var input struct {
		Email       string `json:"email" binding:"required,email"`
		OTP         string `json:"otp" binding:"required"`
		NewPassword string `json:"newPassword" binding:"required,min=6,max=72"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))

	rate := getOTPRateLimit(email)
	rate.mu.Lock()
	defer rate.mu.Unlock()

	now := time.Now()
	if rate.blockedUntil.After(now) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error": fmt.Sprintf("too many failed attempts, try again after %s", rate.blockedUntil.Format(time.RFC3339)),
		})
		return
	}
	if rate.failCount >= 5 {
		rate.blockedUntil = now.Add(5 * time.Minute)
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many failed attempts, try again in 5 minutes"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transaction failed"})
		return
	}
	defer func() { _ = tx.Rollback() }()

	var recordID string
	var expiresAt time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT id, expires_at FROM otp_attempts
		WHERE identifier = $1 AND otp = $2 AND action = 'reset_password' AND verified = false
		ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
		email, input.OTP).Scan(&recordID, &expiresAt)
	if err != nil {
		rate.failCount++
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or expired OTP"})
		return
	}
	if time.Now().After(expiresAt) {
		rate.failCount++
		c.JSON(http.StatusBadRequest, gin.H{"error": "OTP expired"})
		return
	}

	rate.failCount = 0
	rate.blockedUntil = time.Time{}

	_, err = tx.ExecContext(ctx, `UPDATE otp_attempts SET verified = true WHERE id = $1`, recordID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update OTP"})
		return
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), 12)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
		return
	}
	_, err = tx.ExecContext(ctx, `
        UPDATE users SET password_hash = $1 WHERE email = $2`, string(hashed), email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update password"})
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Commit failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to complete reset"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "password reset successfully"})
}

// ---------- Public Key Management ----------
func updatePublicKey(c *gin.Context) {
	var input struct {
		PublicKey string `json:"publicKey" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	userIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	userID, ok := userIDRaw.(string)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid user ID type"})
		return
	}
	_, err := db.ExecContext(c.Request.Context(),
		"UPDATE users SET public_key = $1 WHERE id = $2",
		input.PublicKey, userID)
	if err != nil {
		log.Printf("Failed to update public key for user %s: %v", userID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update public key"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Public key updated successfully"})
}

func getPublicKey(c *gin.Context) {
	requestedUserID := c.Param("userId")
	if requestedUserID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	var publicKey sql.NullString
	err := db.QueryRowContext(c.Request.Context(),
		"SELECT public_key FROM users WHERE id = $1", requestedUserID).Scan(&publicKey)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		} else {
			log.Printf("Error fetching public key for user %s: %v", requestedUserID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch public key"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"publicKey": publicKey.String})
}

// ---------- Email OTP sender (Gmail SMTP) ----------
func sendEmailOTP(ctx context.Context, email, otp string) {
	from := os.Getenv("SMTP_FROM")
	password := os.Getenv("SMTP_PASSWORD")
	smtpHost := os.Getenv("SMTP_HOST")
	smtpPort := os.Getenv("SMTP_PORT")

	if from == "" || password == "" || smtpHost == "" || smtpPort == "" {
		log.Printf("SMTP not configured, logging OTP %s for %s", otp, email)
		return
	}

	to := []string{email}
	subject := "Your OTP (expires in 2 minutes)"
	body := fmt.Sprintf("Your OTP is: %s\nIt expires in 2 minutes.\n\nIf you did not request this, please ignore this email.", otp)
	msg := []byte("To: " + email + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"\r\n" +
		body + "\r\n")

	auth := smtp.PlainAuth("", from, password, smtpHost)
	err := smtp.SendMail(smtpHost+":"+smtpPort, auth, from, to, msg)
	if err != nil {
		log.Printf("Failed to send email OTP to %s: %v", email, err)
	} else {
		log.Printf("OTP sent to %s", email)
	}
}

// ---------- SMS OTP (placeholder) ----------
func sendSMSOTP(ctx context.Context, phone, otp string) {
	log.Printf("📱 Sending OTP %s to phone %s (ctx: %v)", otp, phone, ctx)
}

// ---------- Helpers ----------
func getEnv(key, fallback string) string {
	if val, exists := os.LookupEnv(key); exists {
		return val
	}
	return fallback
}

func nullIfZero(val *int) interface{} {
	if val == nil || *val == 0 {
		return nil
	}
	return *val
}

func nullIfZeroFloat(val *float64) interface{} {
	if val == nil || *val == 0.0 {
		return nil
	}
	return *val
}
