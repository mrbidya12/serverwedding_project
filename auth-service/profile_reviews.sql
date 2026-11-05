// ----- Types (add to your existing models) -----
type ReviewResponse struct {
    ID         string    `json:"id"`
    VendorID   string    `json:"vendor_id"`
    VendorName string    `json:"vendor_name"`
    Rating     int       `json:"rating"`
    Comment    string    `json:"comment"`
    CreatedAt  time.Time `json:"created_at"`
    UpdatedAt  time.Time `json:"updated_at"`
}

type ProfileResponse struct {
    User    User             `json:"user"`
    Reviews []ReviewResponse `json:"reviews"`
}

// ----- Handler (replace your existing profile() function) -----
func profile(c *gin.Context) {
    userID, _ := c.Get("user_id")

    // ---------- 1. Fetch user data (unchanged) ----------
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

    // ---------- 2. Fetch reviews with a dedicated context timeout ----------
    ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
    defer cancel()

    const reviewsQuery = `
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
          AND (r.deleted_at IS NULL OR r.deleted_at > NOW())
        ORDER BY r.created_at DESC
        LIMIT 20
    `
    rows, err := db.QueryContext(ctx, reviewsQuery, userID)
    if err != nil {
        // Log error but still return user data (reviews are optional)
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

    // ---------- 3. Return combined response ----------
    c.JSON(http.StatusOK, gin.H{
        "user":    user,
        "reviews": reviews,
    })
}