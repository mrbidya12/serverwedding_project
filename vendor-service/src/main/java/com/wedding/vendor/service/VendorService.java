package com.wedding.vendor.service;

import com.wedding.vendor.dto.VendorDTO;
import com.wedding.vendor.model.Vendor;
import com.wedding.vendor.repository.VendorRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

@Service
@RequiredArgsConstructor
public class VendorService {
    private final VendorRepository vendorRepo;
    private final Path uploadDir = Paths.get("/app/uploads").toAbsolutePath().normalize();

    public Vendor createVendor(VendorDTO dto, String ownerId) {
        Vendor vendor = Vendor.builder()
                .ownerId(ownerId)
                .name(dto.getName())
                .category(Vendor.Category.valueOf(dto.getCategory()))
                .description(dto.getDescription())
                .contactEmail(dto.getContactEmail())
                .phone(dto.getPhone())
                .city(dto.getCity())
                .basePrice(dto.getBasePrice())
                .approved(false)
                .photoUrls(new ArrayList<>())
                .build();
        return vendorRepo.save(vendor);
    }

    public Vendor uploadPhotos(String vendorId, List<MultipartFile> files) throws IOException {
        Vendor vendor = vendorRepo.findById(vendorId)
                .orElseThrow(() -> new RuntimeException("Vendor not found"));
        Files.createDirectories(uploadDir);
        List<String> urls = new ArrayList<>(vendor.getPhotoUrls());
        for (MultipartFile file : files) {
            String filename = UUID.randomUUID() + "_" + file.getOriginalFilename();
            Path filePath = uploadDir.resolve(filename);
            Files.copy(file.getInputStream(), filePath, StandardCopyOption.REPLACE_EXISTING);
            urls.add("/uploads/" + filename);
        }
        vendor.setPhotoUrls(urls);
        return vendorRepo.save(vendor);
    }

    @Cacheable(value = "vendorsByCategory", key = "#category")
    public Page<Vendor> getByCategory(String category, int page, int size) {
        return vendorRepo.findByCategoryAndApprovedTrue(
                Vendor.Category.valueOf(category), PageRequest.of(page, size));
    }

    @Cacheable(value = "popularVendors")
    public Page<Vendor> getApproved(int page, int size) {
        return vendorRepo.findByApprovedTrue(PageRequest.of(page, size));
    }

    public Vendor getById(String id) {
        return vendorRepo.findById(id).orElseThrow();
    }

    public Vendor setApproval(String id, boolean approved) {
        Vendor v = getById(id);
        v.setApproved(approved);
        return vendorRepo.save(v);
    }

    public Page<Vendor> searchByCity(String city, int page, int size) {
        return vendorRepo.searchByCity(city, PageRequest.of(page, size));
    }
}