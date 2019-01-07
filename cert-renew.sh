#!/bin/bash
sudo systemctl stop regni-server.service
sudo certbot renew --standalone
sudo systemctl start regni-server.service

