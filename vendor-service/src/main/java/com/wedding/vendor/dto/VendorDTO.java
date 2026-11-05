package com.wedding.vendor.dto;

import jakarta.validation.constraints.*;
import lombok.*;

@Data
public class VendorDTO {
    @NotBlank
    private String name;
    @NotBlank
    private String category;
    private String description;
    @Email
    private String contactEmail;
    @Pattern(regexp = "^\\+?[0-9\\-\\s]+$", message = "Invalid phone number")
    private String phone;
    private String city;
    @DecimalMin("0.0")
    private Double basePrice;
}