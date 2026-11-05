// This file handles your booking logic
const Booking = require('./models/booking'); // Assuming you have your model here

exports.createBooking = async (req, res) => {
    try {
        const { vendorId, eventDate, totalPrice } = req.body;
        const userId = req.user.id; // Assuming you have auth middleware

        const newBooking = new Booking({
            userId,
            vendorId,
            eventDate,
            totalPrice,
            status: 'pending'
        });

        await newBooking.save();
        res.status(201).json({ message: "Booking created successfully", booking: newBooking });
    } catch (error) {
        res.status(500).json({ error: "Failed to create booking" });
    }
};

exports.getMyBookings = async (req, res) => {
    try {
        const userId = req.user.id;
        const bookings = await Booking.find({ userId: userId });
        res.status(200).json(bookings);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch bookings" });
    }
};