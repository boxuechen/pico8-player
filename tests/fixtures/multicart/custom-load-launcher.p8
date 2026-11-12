pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
cls(1)
pset(3,4,7)
flip()
load("chapter-b.p8","back from custom","from-custom")
poke(0x5001,0xff)
while true do
 flip()
end
