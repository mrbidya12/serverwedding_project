FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /auth-service

FROM alpine:3.18
RUN apk add --no-cache ca-certificates
COPY --from=builder /auth-service /usr/local/bin/auth-service
EXPOSE 8080
CMD ["/usr/local/bin/auth-service"]