FROM golang:1.20-alpine AS builder
WORKDIR /app
COPY . .
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -mod=mod -o /admin-service

FROM alpine:3.18
COPY --from=builder /admin-service /usr/local/bin/admin-service
EXPOSE 8082
CMD ["admin-service"]