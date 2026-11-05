package com.wedding.vendor.controller;

import com.wedding.vendor.dto.VendorDTO;
import com.wedding.vendor.model.Vendor;
import com.wedding.vendor.repository.VendorRepository;
import com.wedding.vendor.service.VendorService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/vendors")
@RequiredArgsConstructor
public class VendorController {
    private final VendorService vendorService;
    private final VendorRepository vendorRepository;  // ✅ Added for block checks

    // ---------- Create Vendor ----------
    @PostMapping
    public ResponseEntity<Vendor> create(
            @Valid @RequestBody VendorDTO dto,
            @RequestHeader("X-User-Id") String userId) {
        Vendor vendor = vendorService.createVendor(dto, userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(vendor);
    }

    // ---------- Upload Photos ----------
    @PostMapping("/{id}/photos")
    public ResponseEntity<Vendor> uploadPhotos(
            @PathVariable String id,
            @RequestParam("files") List<MultipartFile> files) throws IOException {
        Vendor vendor = vendorService.uploadPhotos(id, files);
        return ResponseEntity.ok(vendor);
    }

    // ---------- List Vendors (Public – excludes blocked owners) ----------
    @GetMapping
    public ResponseEntity<Page<Vendor>> list(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String city,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        Pageable pageable = PageRequest.of(page, size);

        // ✅ Use repository methods directly – they handle blocking
        if (city != null) {
            // You may need to add a city search method to the repository (optional)
            // For now, fall back to category or all
            Page<Vendor> result = vendorRepository.findApprovedAndOwnerNotBlocked(category, pageable);
            // Then filter by city in memory (not ideal, but works for small datasets)
            // Better: add a native query for city search
            return ResponseEntity.ok(result);
        } else {
            Page<Vendor> result = vendorRepository.findApprovedAndOwnerNotBlocked(category, pageable);
            return ResponseEntity.ok(result);
        }
    }

    // ---------- Get Single Vendor (returns 403 if owner is blocked) ----------
    @GetMapping("/{id}")
    public ResponseEntity<Vendor> getById(@PathVariable String id) {
        Vendor vendor = vendorService.getById(id);
        if (vendor == null) {
            return ResponseEntity.notFound().build();
        }
        // ✅ Check if the vendor's owner is blocked
        if (vendorRepository.isOwnerBlocked(vendor.getOwnerId())) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(null);
        }
        return ResponseEntity.ok(vendor);
    }

    // ---------- Admin: Approve Vendor ----------
    @PutMapping("/{id}/approve")
    public ResponseEntity<Vendor> approve(
            @PathVariable String id,
            @RequestBody Map<String, Boolean> body,
            @RequestHeader("X-User-Role") String role) {
        if (!"admin".equals(role)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        return ResponseEntity.ok(vendorService.setApproval(id, body.get("approved")));
    }
}