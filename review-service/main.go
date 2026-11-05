package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

var (
	db        *sql.DB
	jwtSecret = []byte(os.Getenv("JWT_SECRET"))
)

type Review struct {
	ID        string    `json:"id"`
	ClientID  string    `json:"client_id"`
	VendorID  string    `json:"vendor_id"`
	Rating    int       `json:"rating"`
	Comment   string    `json:"comment"`
	CreatedAt time.Time `json:"created_at"`
}

func main() {
	var err error
	dbHost := os.Getenv("DB_HOST")
	if dbHost == "" {
		dbHost = "localhost"
	}
	connStr := "host=" + dbHost + " user=postgres password=postgres dbname=wedding sslmode=disable"
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	r := gin.Default()
	r.GET("/api/reviews/vendor/:vendorId", listByVendor)

	protected := r.Group("/api/reviews")
	protected.Use(authRequired())
	protected.POST("", createReview)

	r.Run(":8083")
}

func listByVendor(c *gin.Context) {
	vendorID := c.Param("vendorId")
	rows, err := db.Query(`SELECT id, client_id, vendor_id, rating, comment, created_at 
		FROM reviews WHERE vendor_id=$1 ORDER BY created_at DESC`, vendorID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var reviews []Review
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.ClientID, &r.VendorID, &r.Rating, &r.Comment, &r.CreatedAt); err != nil {
			continue
		}
		reviews = append(reviews, r)
	}
	c.JSON(http.StatusOK, reviews)
}

func createReview(c *gin.Context) {
	var input struct {
		VendorID string `json:"vendor_id" binding:"required"`
		Rating   int    `json:"rating" binding:"required,min=1,max=5"`
		Comment  string `json:"comment"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	clientID, _ := c.Get("user_id")
	id := uuid.New().String()
	_, err := db.Exec(`INSERT INTO reviews(id, client_id, vendor_id, rating, comment) 
		VALUES($1,$2,$3,$4,$5)`, id, clientID, input.VendorID, input.Rating, input.Comment)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not create review"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "message": "Review created"})
}

func authRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || len(authHeader) < 7 || authHeader[:7] != "Bearer " {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or invalid token"})
			return
		}
		tokenStr := authHeader[7:]
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
			return
		}
		c.Set("user_id", claims["user_id"])
		c.Set("role", claims["role"])
		c.Next()
	}
}
