FROM golang:1.20-alpine AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -o /review-service

FROM alpine:3.18
COPY --from=builder /review-service /usr/local/bin/review-service
EXPOSE 8083
CMD ["review-service"]