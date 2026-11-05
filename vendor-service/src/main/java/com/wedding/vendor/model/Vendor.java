package com.wedding.vendor.model;

import jakarta.persistence.*;
import lombok.*;
import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "vendors")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Vendor {

    @Id
    private String id;                         // ✅ removed default initialiser

    private String ownerId;
    private String name;

    @Enumerated(EnumType.STRING)
    private Category category;

    @Column(columnDefinition = "TEXT")
    private String description;

    private String contactEmail;
    private String phone;
    private String city;
    private Double basePrice;

    @ElementCollection
    @CollectionTable(name = "vendor_photos", joinColumns = @JoinColumn(name = "vendor_id"))
    @Column(name = "photo_url")
    private List<String> photoUrls;

    private boolean approved;
    private LocalDateTime createdAt;            // ✅ removed default initialiser

    // new fields
    private String country;
    private String state;
    private String block;
    private String pincode;
    private Integer yearsOfExperience;
    private Double minPrice;
    private Double maxPrice;

    // ✅ This method is called BEFORE the entity is persisted
    @PrePersist
    public void prePersist() {
        if (id == null) {
            id = UUID.randomUUID().toString();   // ✅ set id only if null
        }
        createdAt = LocalDateTime.now();         // ✅ set creation timestamp
    }

    public enum Category {
        PHOTOGRAPHER, DECORATION, CATERING, MEHENDI, DJ,
        MAKEUP, CHEF, MARRIAGE_ORGANIZER, BRAHMA_PUROHIT,
        MANDAP_OWNER, BARBER, VEHICLE_OWNER, JEWELER,
        INVITATION_DESIGNER, BRASS_BAND, OTHER
    }
}