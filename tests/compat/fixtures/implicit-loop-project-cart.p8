pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
q=1
cls(3)
while true do
 pset(q&127,(q>>7)&63,7)
 q=1+q&8191
end
