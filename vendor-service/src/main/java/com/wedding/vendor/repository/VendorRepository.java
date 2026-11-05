package com.wedding.vendor.repository;

import com.wedding.vendor.model.Vendor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface VendorRepository extends JpaRepository<Vendor, String> {

    // ---------- Existing methods ----------
    Page<Vendor> findByCategoryAndApprovedTrue(Vendor.Category category, Pageable pageable);
    Page<Vendor> findByApprovedTrue(Pageable pageable);
    List<Vendor> findByOwnerId(String ownerId);

    @Query("SELECT v FROM Vendor v WHERE v.approved = true AND v.city ILIKE %:city%")
    Page<Vendor> searchByCity(@Param("city") String city, Pageable pageable);

    // ---------- Blocked vendor filtering ----------

    /**
     * Fetch approved vendors whose owner is NOT blocked.
     */
    @Query(value = "SELECT v.* FROM vendors v " +
                   "JOIN users u ON v.owner_id = u.id " +
                   "WHERE v.approved = true " +
                   "AND (u.blocked_until IS NULL OR u.blocked_until < NOW()) " +
                   "AND (:category IS NULL OR v.category = :category)",
           nativeQuery = true)
    Page<Vendor> findApprovedAndOwnerNotBlocked(@Param("category") String category, Pageable pageable);

    /**
     * Check if a vendor's owner is currently blocked.
     */
    @Query(value = "SELECT EXISTS (SELECT 1 FROM users WHERE id = :ownerId " +
                   "AND blocked_until IS NOT NULL AND blocked_until > NOW())",
           nativeQuery = true)
    boolean isOwnerBlocked(@Param("ownerId") String ownerId);
}